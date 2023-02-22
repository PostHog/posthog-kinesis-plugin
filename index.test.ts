import { CacheExtension, StorageExtension } from '@posthog/plugin-scaffold'
import AWS from 'aws-sdk'
import Redis from 'ioredis'
import posthog from 'posthog-js'
import { v4 } from 'uuid'

import * as kinesisPlugin from './index'

jest.setTimeout(60_000)

test('trasformKinesisRecordToPosthogEvent', () => {
    const eventKey = 'event'
    const additionalPropertyMappings = 'props.foo:foo'
    const event = { event: 'kinesis test', props: { foo: 'bar' } }

    // successful case
    expect(kinesisPlugin.transformKinesisRecordToPosthogEvent(event, eventKey, additionalPropertyMappings)).toEqual({
        event: 'kinesis test',
        properties: {
            foo: 'bar',
        },
    })

    // wrong property mappings
    const wrongAdditionalPropertyMappings2 = 'props.bar:foo'
    expect(
        kinesisPlugin.transformKinesisRecordToPosthogEvent(event, eventKey, wrongAdditionalPropertyMappings2)
    ).toEqual({
        event: 'kinesis test',
        properties: {},
    })

    // wrong event key
    const wrongEventKey = 'wrong_event_key'
    expect(
        kinesisPlugin.transformKinesisRecordToPosthogEvent(event, wrongEventKey, additionalPropertyMappings)
    ).toEqual(null)
})

describe('plugin functionality', () => {
    let redis: Redis
    let cache: CacheExtension
    let storage: StorageExtension

    beforeAll(() => {
        redis = new Redis()
        cache = getCache(redis)
        storage = getStorage()
    })

    afterAll(async () => {
        await redis.quit()
    })

    test('can import correctly formatted event', async () => {
        // Here we want to:
        //
        //  1. setup a client for AWS Kinesis pointing at our local running
        //     localstack server
        //  2. call `setupPlugin` with Kinesis config pointing at our localstack
        //     server
        //  3. produce a message to Kinesis as per the documentation
        //     [here](https://posthog.com/docs/apps/amazon-kinesis#how-should-i-configure-the-kinesis-record-schema)
        //  4. check that capture is called with the expected event
        //
        // To ensure `aws-sdk` is using our localstack server, we set the
        // `AWS_ENDPOINT` environment variable. This is picked up by the
        // `aws-sdk` client.
        //

        AWS.config.update({
            accessKeyId: 'awsAccessKeyId',
            secretAccessKey: 'awsSecretAccessKey',
            region: 'us-east-1',
            kinesis: {
                endpoint: 'http://localhost:4566',
            },
        })

        const kinesis = new AWS.Kinesis()
        const streamName = v4()
        const eventKey = 'event'
        const eventType = 'kinesis test'

        // Create a Kinesis stream to produce messages to. Before we can produce
        // to the stream, we have to wait for it to become ACTIVE. The
        // `createStream` command immediately returns while the stream is still
        // in `CREATING` state.
        console.log(`Creating Kinesis stream: ${streamName}`)
        await createStreamAndWaitToBeActive(kinesis, streamName)

        // Before setting up the plugin, we need to spyOn the `capture` function
        // so we can check that it is called with the expected event.
        const capture = jest.spyOn(posthog, 'capture')

        const config = {
            kinesisStreamName: streamName,
            eventKey: eventKey,
            additionalPropertyMappings: 'props.foo:foo',
            awsRegion: 'us-east-1',
            iamAccessKeyId: 'test',
            iamSecretAccessKey: 'test',
        }

        const metaForwardRef = {}
        const meta = Object.assign(metaForwardRef, {
            config,
            global: { kinesis },
            cache,
            storage,
            jobs: createJobs(kinesisPlugin.jobs)(metaForwardRef as any),
            geoip: {} as any,
            attachments: {},
            metrics: {} as any,
            utils: {} as any,
        })

        console.log('Setting up plugin...')
        await kinesisPlugin.setupPlugin(meta)

        // Note that `runEveryMinute` will spawn background jobs that will
        // happen asynchronously.
        //
        // Also important is that the Kinesis Stream iterator is created using
        // the `ShardIteratorType` of `LATEST`. This means that the iterator
        // will only return records that are produced after the iterator is
        // created. As a result, we have an awkward race condition.
        //
        // To work around this race condition, we rely on the fact that the
        // plugin at the time of writing will persist the iterator key in redis,
        // so we wait for the iterator to be persisted before producing the
        // record to Kinesis.
        console.log('Running plugin...')
        await kinesisPlugin.runEveryMinute(meta)

        // Wait for the iterator to be persisted in redis.
        await new Promise((resolve) => {
            const interval = setInterval(async () => {
                if (await cache.get('kinesis-iterator', null)) {
                    clearInterval(interval)
                    resolve(null)
                }
            }, 100)
        })

        // `runEventMinute` does not return a promise that we can wait on, so we
        // need to poll for the expected event to be captured.
        await new Promise((resolve) => {
            const interval = setInterval(() => {
                if (capture.mock.calls.length > 0) {
                    clearInterval(interval)
                    resolve(null)
                }
            }, 100)
        })

        // Now we can produce a record to Kinesis.
        console.log('Producing record to Kinesis...')
        await produceMessageToKinesis(kinesis, streamName, eventKey, {
            event: eventType,
            props: {
                foo: 'bar',
            },
        })

        await kinesisPlugin.runEveryMinute(meta)

        expect(capture).toHaveBeenCalledWith(eventType, { foo: 'bar' }, expect.anything())
    })
})

const createJobs = (jobs: typeof kinesisPlugin.jobs) => (meta: kinesisPlugin.KinesisMeta) => {
    const createJob =
        (job: (payload: any, meta: kinesisPlugin.KinesisMeta) => Promise<void>) =>
        (meta: kinesisPlugin.KinesisMeta) =>
        (payload: any) => ({
            runIn: async (runIn: number, _: string) => {
                await new Promise((resolve) => setTimeout(resolve, runIn))
                return await job(payload, meta)
            },
            runNow: async () => {
                await job(payload, meta)
            },
            runAt: async (date: Date) => {
                await new Promise((resolve) => setTimeout(resolve, date.getTime() - Date.now()))
                return await job(payload, meta)
            },
        })

    return Object.fromEntries(Object.entries(jobs).map(([jobName, jobFn]) => [jobName, createJob(jobFn)(meta)]))
}

async function produceMessageToKinesis(kinesis: AWS.Kinesis, streamName: string, eventKey: string, event: any = {}) {
    await new Promise((resolve, reject) =>
        kinesis.putRecord(
            {
                StreamName: streamName,
                PartitionKey: 'test',
                Data: JSON.stringify(event),
            },
            (err, data) => {
                if (err) {
                    reject(err)
                } else {
                    resolve(data)
                }
            }
        )
    )
}

async function createStreamAndWaitToBeActive(kinesis: AWS.Kinesis, streamName: string) {
    await new Promise((resolve, reject) =>
        kinesis.createStream(
            {
                ShardCount: 1,
                StreamName: streamName,
            },
            (err, data) => {
                if (err) {
                    reject(err)
                } else {
                    resolve(data)
                }
            }
        )
    )

    await new Promise((resolve, reject) => {
        const checkStreamStatus = () => {
            kinesis.describeStream(
                {
                    StreamName: streamName,
                },
                (err, data) => {
                    if (err) {
                        reject(err)
                    } else {
                        if (data.StreamDescription.StreamStatus === 'ACTIVE') {
                            resolve(data)
                        } else {
                            setTimeout(checkStreamStatus, 1000)
                        }
                    }
                }
            )
        }
        checkStreamStatus()
    })
}

// NOTE: below is largely copied from
// https://github.com/PostHog/snowflake-export-plugin/blob/main/index.test.ts#LL265-L317C3

const getCache = (redis: Redis): CacheExtension => {
    // Create something that looks like a plugin-server provided cache, using
    // redis as the storage backend.
    return {
        lpush: redis.lpush.bind(redis),
        llen: redis.llen.bind(redis),
        lrange: redis.lrange.bind(redis),
        set: redis.set.bind(redis),
        expire: redis.expire.bind(redis),
        get: (key: string, _: unknown) => redis.get(key),
        incr: redis.incr.bind(redis),
        lpop: redis.lpop.bind(redis),
        lrem: redis.lrem.bind(redis),
    } as any // I just typecast here as there are too many type issues
}

const getStorage = () => {
    // Create something that looks like a plugin-server provided storage, using
    // a Map as the storage backend.
    const mockStorage = new Map()

    return {
        // Based of https://github.com/PostHog/posthog/blob/master/plugin-server/src/worker/vm/extensions/storage.ts
        get: async function (key: string, defaultValue: unknown): Promise<unknown> {
            await Promise.resolve()
            if (mockStorage.has(key)) {
                const res = mockStorage.get(key)
                if (res) {
                    return JSON.parse(String(res))
                }
            }
            return defaultValue
        },
        set: async function (key: string, value: unknown): Promise<void> {
            await Promise.resolve()
            if (typeof value === 'undefined') {
                mockStorage.delete(key)
            } else {
                mockStorage.set(key, JSON.stringify(value))
            }
        },
        del: async function (key: string): Promise<void> {
            await Promise.resolve()
            mockStorage.delete(key)
        },
    }
}
