#!/bin/bash

# Copyright 2018 Vista Higher Learning, Inc.
# Copyright 2018 Jesse Cotton <jcotton@bitlancer.com>
#
# Licensed under the Apache License, Version 2.0 (the "License"); you
# may not use this file except in compliance with the License.  You
# may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
# implied.  See the License for the specific language governing
# permissions and limitations under the License.


if [ ! -f config ]; then
  echo "Configuration file 'config' is missing!"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "node_modules directory is missing!"
  exit 1
fi

source config || exit 1

echo "Creating bucket $BUCKET"
aws s3 mb "s3://$BUCKET" || exit 1
echo "Bucket $BUCKET created"

echo 'Creating lambda zip artifact'
zip -j rds-snapshot-copier.zip src/*
zip -r rds-snapshot-copier.zip node_modules
echo 'Lambda artifact created'

echo 'Moving lambda artifact to S3'
aws s3 cp rds-snapshot-copier.zip s3://$BUCKET/$RELEASE/rds-snapshot-copier.zip
rm rds-snapshot-copier.zip
echo 'Lambda artifact moved'

operation='create-stack'
aws cloudformation describe-stacks --stack-name $STACK_NAME >/dev/null 2>&1
if [ $? -eq 0 ]; then
    operation='update-stack' 
fi

echo 'Creating/Updating stack' 
aws cloudformation $operation \
    --template-body file://cloudformation/rds-snapshot-copier.json \
    --stack-name $STACK_NAME \
    --capabilities CAPABILITY_IAM \
    --parameters \
      "ParameterKey=DatabaseInstanceFilter,ParameterValue=$DATABASE_INSTANCE_FILTER" \
      "ParameterKey=MaintainXSnapshots,ParameterValue=$MAINTAIN_X_SNAPSHOTS" \
      "ParameterKey=CopyRetryInterval,ParameterValue=$COPY_RETRY_INTERVAL" \
      "ParameterKey=SnapshotCopyAgeWarning,ParameterValue=$SNAPSHOT_COPY_AGE_WARNING" \
      "ParameterKey=SnapshotCopyAgeAlert,ParameterValue=$SNAPSHOT_COPY_AGE_ALERT" \
      "ParameterKey=SlackWebhookUrl,ParameterValue=$SLACK_WEBHOOK_URL" \
      "ParameterKey=SlackAlertsChannel,ParameterValue=$SLACK_ALERTS_CHANNEL" \
      "ParameterKey=SlackWarningsChannel,ParameterValue=$SLACK_WARNINGS_CHANNEL" \
      "ParameterKey=DisasterRecoveryKmsKey,ParameterValue=$DR_KMS_KEY" \
      "ParameterKey=DisasterRecoveryRegion,ParameterValue=$DR_REGION" \
      "ParameterKey=EventTopicName,ParameterValue=$EVENT_TOPIC_NAME" \
      "ParameterKey=ArtifactBucket,ParameterValue=$BUCKET" \
      "ParameterKey=Release,ParameterValue=$RELEASE" \
    --output text && \
echo 'Done'
