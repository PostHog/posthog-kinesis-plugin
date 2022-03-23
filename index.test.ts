import { transformKinesisRecordToPosthogEvent } from './index'

test('trasformKinesisRecordToPosthogEvent', () => {
    const eventKey = 'event'
    const additionalPropertyMappings = 'props.foo:foo'
    const event = { event: 'kinesis test', props: { foo: 'bar' } }

    // successful case
    expect(transformKinesisRecordToPosthogEvent(event, eventKey, additionalPropertyMappings)).toEqual({
        event: 'kinesis test',
        properties: {
            foo: 'bar',
        },
    })

    // wrong property mappings
    const wrongAdditionalPropertyMappings2 = 'props.bar:foo'
    expect(transformKinesisRecordToPosthogEvent(event, eventKey, wrongAdditionalPropertyMappings2)).toEqual({
        event: 'kinesis test',
        properties: {},
    })

    // wrong event key
    const wrongEventKey = 'wrong_event_key'
    expect(transformKinesisRecordToPosthogEvent(event, wrongEventKey, additionalPropertyMappings)).toEqual(null)
})
