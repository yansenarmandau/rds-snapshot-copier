# RDS Snapshot Copier

This Lambda copies RDS snapshots from a primary region to an alternate region to support disaster recovery.

## How it Works

* A SNS topic is setup and configured to recieve RDS events related to backups.
* This Lambda is "subscribed" to the above SNS topic and is "listening" for RDS events indicating a backup completed. The RDS backup event is used as a Lambda trigger to ensure backups are copied as soon as they are available.
* When the Lambda is triggered it performs a snapshot rotation for the originating database instance - copying the new snapshot(s) to the DR region and purging old snapshots from the DR region.
* This Lambda is also triggered on a schedule to check that snapshots are being copied to the DR region on specified schedule, and it will retry any copies that failed. This is implemented to workaround the limitation of 5 simultaneous snapshot copies.

## Configuration

Settings are managed in the `config` file which is sourced by the deploy script. A sample configuration file is provided at [config.sample](config.sample). Below each setting is documented.

**ENV**

The environment you're deploying this utility in: dev, qa, prod, etc.

**MAINTAIN_X_SNAPSHOTS**

The number of snapshots to retain for each database instance.

**COPY_RETRY_INTERVAL**

How often, in hours, the function should be triggered to check for snapshots missing from the DR region and to retry copies.

**SNAPSHOT_COPY_AGE_WARNING**

The snapshot age in hours that should trigger a warning if not copied to the DR region yet.

**SNAPSHOT_COPY_AGE_ALERT**

The snapshot age in hours that should trigger an alert if not copied to the DR region yet.

**DR_KMS_KEY**

The KMS key that's used to encrypt database snapshots in the DR region.

**DR_REGION**

The region where snapshots should be copied/stored.

**SLACK_WEBHOOK_URL**

The Slack Webhook URL used for Slack integration.

This parameter is optional. If you do not define a Slack webhook Slack notifications will be disabled.

**SLACK_ALERTS_CHANNEL**

The Slack channel alerts are directed at.

This parameter is optional.

**SLACK_WARNINGS_CHANNEL**

The Slack channel warnings are directed at.

This parameter is optional.

**DATABASE_INSTANCE_FILTER**

If specified, *only* snapshots with a source database instance matching this regex expression will copied.

This parameter is optional.

**EVENT_TOPIC_NAME**

The name of the SNS topic that RDS backup events are directed to and trigger this Lambda to run.

## Deploy

* Execute:

```
export AWS_PROFILE=default
export AWS_DEFAULT_REGION=us-east-1
npm install
./deploy.sh
```

* Perform the initial snapshot sync by triggering the Lambda with this special test event:

```
{
  "command": "initial_sync"
}
```
