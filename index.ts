import { CacheExtension, Plugin, PluginEvent, PluginMeta, RetryError } from '@posthog/plugin-scaffold'
import { Kinesis } from 'aws-sdk'

type KinesisPlugin = Plugin<{
    global: {
        kinesis: Kinesis
    }
    config: {
        kinesisStreamName: string
        iamAccessKeyId: string
        iamSecretAccessKey: string
        awsRegion: string
    }
}>

type KinesisMeta = PluginMeta<KinesisPlugin>

export async function setupPlugin({ config, global }: KinesisMeta): Promise<void> {
    global.kinesis = new Kinesis({
        accessKeyId: config.iamAccessKeyId,
        secretAccessKey: config.iamSecretAccessKey,
        region: config.awsRegion,
    })
}

export async function runEveryMinute(meta: KinesisMeta): Promise<void> {
    await getEventsFromKinesis(meta)
}

const REDIS_KINESIS_STREAM_KEY = '_kinesis_shard_'

function hasOneMinutePassed(startedAt: number) {
    return new Date().getTime() - startedAt > 1000 * 60
}

async function processShard({ config, global, cache }: KinesisMeta, shard: Kinesis.Shard, startedAt: number) {
    const cacheKey = `${REDIS_KINESIS_STREAM_KEY}${config.kinesisStreamName}_${shard.ShardId}`
    const nextShardIterator = (await cache.get(cacheKey, null)) as string | null
    if (nextShardIterator) {
        getRecords(global.kinesis, cache, cacheKey, nextShardIterator, startedAt)
    } else {
        global.kinesis.getShardIterator(
            {
                ShardId: shard.ShardId,
                ShardIteratorType: 'LATEST',
                StreamName: config.kinesisStreamName,
            },
            function (err, shardIteratordata) {
                if (err) {
                    console.error(err, err.stack)
                } else {
                    // console.log(shardIteratordata); // successful response
                    const { ShardIterator } = shardIteratordata
                    if (ShardIterator) {
                        getRecords(global.kinesis, cache, cacheKey, ShardIterator, startedAt)
                    } else {
                        console.error('ShardIterator is not defined')
                    }
                }
            }
        )
    }
}

function getRecords(
    kinesis: Kinesis,
    cache: CacheExtension,
    cacheKey: string,
    shardIterator: string,
    startedAt: number
): void {
    kinesis.getRecords(
        {
            ShardIterator: shardIterator,
        },
        function (err, recordsData) {
            if (err) {
                console.error(err, err.stack)
            } else {
                if (recordsData.Records.length > 0) {
                    console.log(recordsData.Records) // successful response
                } else {
                    console.log('no records')
                }
                // we iterate only for max one minute, then run again the process
                if (recordsData.NextShardIterator) {
                    cache.set(cacheKey, recordsData.NextShardIterator)
                    cache.expire(cacheKey, 120)
                    if (!hasOneMinutePassed(startedAt)) {
                        getRecords(kinesis, cache, cacheKey, recordsData.NextShardIterator, startedAt)
                    }
                }
            }
        }
    )
}

async function getEventsFromKinesis(meta: KinesisMeta): Promise<void> {
    const { global, config } = meta
    const startedAt = new Date().getTime()
    global.kinesis.describeStream(
        {
            StreamName: config.kinesisStreamName,
        },
        function (err, streamData) {
            if (err) {
                console.error(err, err.stack)
            } else {
                //   console.log(streamData); // successful response
                streamData.StreamDescription.Shards.forEach((shard) => processShard(meta, shard, startedAt))
            }
        }
    )
}
