import { CacheExtension, Plugin, PluginMeta } from '@posthog/plugin-scaffold'
import { Kinesis } from 'aws-sdk'

declare const posthog: {
    capture: (eventName: string, properties: Record<string, unknown>) => void
}

type KinesisPlugin = Plugin<{
    global: {
        kinesis: Kinesis
    }
    config: {
        kinesisStreamName: string
        iamAccessKeyId: string
        iamSecretAccessKey: string
        awsRegion: string
        eventKey: string
        additionalPropertyMappings: string
    }
}>

export type KinesisMeta = PluginMeta<KinesisPlugin>

const REDIS_KINESIS_STREAM_KEY = '_kinesis_shard_'

export async function setupPlugin({ config, global }: KinesisMeta): Promise<void> {
    global.kinesis = new Kinesis({
        accessKeyId: config.iamAccessKeyId,
        secretAccessKey: config.iamSecretAccessKey,
        region: config.awsRegion,
    })
}

export const jobs = {
    processShard,
}

export async function runEveryMinute(meta: KinesisMeta): Promise<void> {
    readKinesisStream(meta)
}

function readKinesisStream(meta: KinesisMeta): void {
    const { global, config } = meta
    // we keep track of the starting time of the process, to only poll kinesis for one minute before restarting
    const startedAt = new Date().getTime()
    global.kinesis.describeStream(
        {
            StreamName: config.kinesisStreamName,
        },
        function (err, streamData) {
            if (err) {
                console.error(err, err.stack)
            } else {
                // kinesis streams are composed of shards, we need to process each shard independently
                streamData.StreamDescription.Shards.forEach((shard) =>
                    meta.jobs.processShard({ shard, startedAt }).runNow()
                )
            }
        }
    )
}

// we need to iterate through the sequences inside of a shard, to do that we required a shard iterator
// the `LATEST` property tells Kinesis to give us sequences starting from now, discarding historic data
function getShardIterator(
    kinesis: Kinesis,
    streamName: string,
    shardId: string,
    callback: (shardIterator: string) => void
) {
    kinesis.getShardIterator(
        {
            ShardId: shardId,
            ShardIteratorType: 'LATEST',
            StreamName: streamName,
        },
        function (err, shardIteratordata) {
            if (err) {
                console.error(err, err.stack)
                return
            }
            const { ShardIterator } = shardIteratordata
            if (ShardIterator) {
                callback(ShardIterator)
            } else {
                console.error('ShardIterator is not defined')
            }
        }
    )
}

// we check if we already have a shardIterator in cache, otherwise we get one and use it to get records at a specific sequence
async function processShard(
    { shard, startedAt }: { shard: Kinesis.Shard; startedAt: number },
    { config, global, cache }: KinesisMeta
): Promise<void> {
    const shardId = shard.ShardId
    const cacheKey = `${REDIS_KINESIS_STREAM_KEY}${config.kinesisStreamName}_${shard.ShardId}`
    const nextShardIterator = (await cache.get(cacheKey, null)) as string | null
    if (nextShardIterator) {
        getRecords(global.kinesis, cache, cacheKey, shardId, nextShardIterator, startedAt, config)
    } else {
        getShardIterator(global.kinesis, config.kinesisStreamName, shardId, (iterator: string) => {
            getRecords(global.kinesis, cache, cacheKey, shardId, iterator, startedAt, config)
        })
    }
}

function getRecords(
    kinesis: Kinesis,
    cache: CacheExtension,
    cacheKey: string,
    shardId: string,
    shardIterator: string,
    startedAt: number,
    config: KinesisMeta['config']
): void {
    kinesis.getRecords(
        {
            ShardIterator: shardIterator,
        },
        function (err, recordsData) {
            if (err) {
                // shardIterators can expire, in this case we need to fetch a new one, before running again the getRecords function
                if (err.name === 'ExpiredIteratorException') {
                    getShardIterator(kinesis, config.kinesisStreamName, shardId, (iterator: string) => {
                        getRecords(kinesis, cache, cacheKey, shardId, iterator, startedAt, config)
                    })
                } else {
                    console.error(err, err.stack)
                }
            } else {
                // if there are Records at the current sequence, we process them, and if successful, use posthog-js to capture them as events
                if (recordsData.Records.length > 0) {
                    recordsData.Records.forEach(function (record) {
                        // we read the record buffer and parse a JSON
                        const payload = decodeBuffer(record.Data)
                        if (!payload) {
                            return
                        }
                        const posthogEvent = transformKinesisRecordToPosthogEvent(
                            payload,
                            config.eventKey,
                            config.additionalPropertyMappings
                        )
                        if (posthogEvent) {
                            console.log(`Event captured from Kinesis stream: ${JSON.stringify(posthogEvent)}`)
                            posthog.capture(posthogEvent.event, posthogEvent.properties)
                        }
                    })
                }
                // Kinesis gives us a nextShardIterator, which we keep in cache
                if (recordsData.NextShardIterator) {
                    cache.set(cacheKey, recordsData.NextShardIterator)
                    cache.expire(cacheKey, 120)
                    // we iterate only for max one minute
                    if (!hasOneMinutePassed(startedAt)) {
                        getRecords(kinesis, cache, cacheKey, shardId, recordsData.NextShardIterator, startedAt, config)
                    }
                }
            }
        }
    )
}

interface PosthogEvent {
    event: string
    properties: Record<string, string>
}

export function transformKinesisRecordToPosthogEvent(
    payload: Record<string, unknown>,
    eventKey: string,
    additionalPropertyMappings: string
): PosthogEvent | null {
    try {
        const event = getDeepValue(payload, eventKey.split('.'))
        if (!event) {
            console.error(`Cannot find key ${eventKey} in object ${payload}`)
            return null
        }
        const properties: Record<string, string> = {}
        const additionalMappings = additionalPropertyMappings.split(',')
        additionalMappings.forEach((mapping) => {
            const [key, mappedKey] = mapping.split(':')
            const value = getDeepValue(payload, key.split('.'))
            if (!value) {
                console.error(`Property ${key} does not exist, skipping`)
            } else if (typeof value !== 'string') {
                console.error(`Property ${key} does not contain a string value, skipping`)
            } else {
                properties[mappedKey] = value
            }
        })
        return { event, properties }
    } catch (e) {
        console.error(e)
        return null
    }
}

function decodeBuffer(data: Kinesis.Record['Data']) {
    try {
        //@ts-expect-error Kinesis Record is Uint8Array but it's not correctly typed
        const payload = Buffer.from(data).toString()
        return JSON.parse(payload)
    } catch (e: any) {
        console.error(`Failed decoding Buffer, skipping record: ${e.message || String(e)}`)
        return null
    }
}

function getDeepValue(payload: Record<string, unknown>, args: string[]) {
    let obj = Object.assign(payload)
    for (let i = 0; i < args.length; i++) {
        if (!obj || !obj.hasOwnProperty(args[i])) {
            return null
        }
        obj = obj[args[i]]
    }
    return obj
}

function hasOneMinutePassed(startedAt: number) {
    return new Date().getTime() - startedAt > 1000 * 60
}
