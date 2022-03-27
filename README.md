# PostHog Kinesis Plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](https://opensource.org/licenses/MIT)

This plugins sends event data to Posthog from a Kinesis Stream.

## Record schema

Kinesis Records must be delivered in a JSON schema.

You need to configure an `eventKey` that maps to the event name in Posthog. The `eventKey` can refer to a nested key.
You can optionally configure a comma-separated list of `additionalPropertyMappings`, that will map Kinesis Record keys to Posthog Event properties. The Kinesis Record keys can be nested keys, while the corresponding Posthog mapped keys cannot be nested.

For example, take the following Kinesis Record

```
// Kinesis Record
{
    ...
    "properties: {
        "eventName": "my posthog event",
        "userId": "$userId",
        "foo": "bar"
    }
}
```

And the following configuration:

```
eventKey = properties.eventName
additionalPropertyMappings = properties.userId:distinct_id,properties.foo:foo
```

This will be parsed as:

```
// Posthog Event
{
    "event": "my posthog event",
    "properties: {
        "distinct_id": "$userId",
        "foo": "bar"
    }
}
```

## IAM policy

You need to provide an AccessKeyID and a SecretAccessKey for a AWS IAM user with at least the following Kinesis Action rights:

```
DescribeStream
GetShardIterator
GetRecords
```

## Plugin Parameters:

-   `Kinesis Stream Name` (required): the name of the Kinesis stream you want to read from
-   `IAM Access Key ID` (required): IAM Access Key ID with Kinesis access
-   `IAM Secret Access Key` (required): IAM Secret Access Key with Kinesis access
-   `AWS Region` (required): AWS region where your Kinesis stream is deployed
-   `Event Key` (required): The Kinesis Record key to be mapped to the PostHog event name. Can be nested (e.g. `properties.eventName`)
-   `Additional Property Mappings`: A comma-separated mapping of additional Kinesis Record keys to map to Posthog event properties. Can be nested (e.g. `properties.kinesisPropertyKey:posthogPropertyKey`)

## Installation

-   Visit 'Project Plugins' under 'Settings'
-   Enable plugins if you haven't already done so
-   Click the 'Repository' tab next to 'Installed'
-   Click 'Install' on this plugin
-   Fill in required parameters (see above)
-   Enable the plugin
