// Copyright 2018 Vista Higher Learning, Inc.
// Copyright 2018 Jesse Cotton <jcotton@bitlancer.com>
//
// Licensed under the Apache License, Version 2.0 (the "License"); you
// may not use this file except in compliance with the License.  You
// may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
// implied.  See the License for the specific language governing
// permissions and limitations under the License.

'use strict';

const aws = require('aws-sdk');
const dateFormat = require('dateformat');
const slackWebHook = require('@slack/client').IncomingWebhook;

const DR_REGION = process.env.DR_REGION;
const DR_KMS_KEY = process.env.DR_KMS_KEY;

const DATABASE_INSTANCE_FILTER = process.env.DATABASE_INSTANCE_FILTER;

const MAINTAIN_X_SNAPSHOTS = process.env.MAINTAIN_X_SNAPSHOTS;
const SNAPSHOT_COPY_AGE_WARNING = process.env.SNAPSHOT_COPY_AGE_WARNING;
const SNAPSHOT_COPY_AGE_ALERT = process.env.SNAPSHOT_COPY_AGE_ALERT;

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SLACK_WARNINGS_CHANNEL = process.env.SLACK_WARNINGS_CHANNEL;
const SLACK_ALERTS_CHANNEL = process.env.SLACK_ALERTS_CHANNEL;

var enumerateDBInstances = function(exitCallback, dbCallback) {
  let rdsClient = new aws.RDS();
  let dbInstances = [];

  rdsClient.describeDBInstances().on('success', function enumerateDBs(response) {
    response.data.DBInstances.forEach(function(dbInstance) {
      dbInstances.push(dbInstance);
    });
    if(response.hasNextPage()) {
      response.nextPage().on('success', enumerateDBs).send();
    }
    else {
      let promises = [];

      dbInstances.forEach(function(dbInstance) {
        promises.push(new Promise(function(resolve, reject) {
          dbCallback(dbInstance, function(err) {
            if(err) {
              reject(err);
            }
            else {
              resolve();
            }
          });
        }));
      });

      Promise.all(promises).then(function() {
        exitCallback(null);
      }, function(err) {
        logError(JSON.stringify(err));
        exitCallback(err);
      });
    }
  }).on('error', function(err) {
    logError('Error encountered enumerating instances: ' + JSON.stringify(err));
    exitCallback(err);
  }).send();
};

var rotateDisasterRecoverySnapshots = function(dbInstanceId, rotationDate, disableAgeCheck, callback) {
  if(!matchDbInstanceFilter(dbInstanceId)) {
    logMessage("Skipping database b/c it does not match instance filter", dbInstanceId);
    return callback(null);
  }

  copySnapshots(dbInstanceId, rotationDate, disableAgeCheck, function(err, success) {
    if(err) {
      logError('Error encountered while copying snapshots: ' + JSON.stringify(err), dbInstanceId);
      callback(err);
    }
    else {
      deleteOldSnapshots(dbInstanceId, rotationDate, function(err, succcess) {
        if(err) {
          logError('Error encountered while deleting snapshots: ' + JSON.stringify(err), dbInstanceId);
        }
        callback(err, success);
      });
    }
  });
};

var matchDbInstanceFilter = function(dbInstanceId) {
  if(!DATABASE_INSTANCE_FILTER) return true;
  let dbInstanceFilterRegex = new RegExp(DATABASE_INSTANCE_FILTER);
  return dbInstanceId.match(dbInstanceFilterRegex);
};

var copySnapshots = function(dbInstanceId, rotationDate, disableAgeCheck, callback) {
  let rdsClient = new aws.RDS();
  let rdsClientDr = new aws.RDS({region: DR_REGION});
  let maybeCopySnapshots = [];

  logMessage('Kicking off snapshot copies', dbInstanceId);
  logMessage('Retrieving snapshots for database instance', dbInstanceId);

  rdsClient.describeDBSnapshots({
    DBInstanceIdentifier: dbInstanceId,
    IncludePublic: false,
    IncludeShared: false,
    SnapshotType: 'automated'
  }).on('success', function enumerateSnapshots(response) {
    response.data.DBSnapshots.forEach(function(snapshot) {
      if(snapshot.Status == 'available' && snapshot.SnapshotCreateTime.getTime() > rotationDate.getTime()) {
        maybeCopySnapshots.push(snapshot);
      }
    });

    if(response.hasNextPage()) {
      response.nextPage().on('success', enumerateSnapshots).send();
    }
    else {
      let promises = [];

      if(maybeCopySnapshots.length == 0) {
        logMessage('No snapshots need to be copied to the DR region', dbInstanceId);
        return callback(null, 'success');
      }

      let snapshotListStr = maybeCopySnapshots.map(function(item) {
        return item.DBSnapshotIdentifier;
      }).join(', ');
      logMessage('Evaluating snapshots for copy: ' + snapshotListStr, dbInstanceId);

      maybeCopySnapshots.forEach(function(snapshot) {
        promises.push(new Promise(function(resolve, reject) {
          let drSnapshotId = snapshot.DBSnapshotIdentifier.replace('rds:', '');
          let nowTimestamp = (new Date().getTime()) / 1000;
          let snapshotTimestamp = (new Date(snapshot.SnapshotCreateTime).getTime()) / 1000;
          let snapshotAgeHours = (nowTimestamp - snapshotTimestamp) / 60 / 60;

          rdsClientDr.describeDBSnapshots({DBSnapshotIdentifier: drSnapshotId}, function(err, data) {
            if(!err || err.code != 'DBSnapshotNotFound') {
              logMessage("Snapshot " + drSnapshotId + " already exists in DR region.", dbInstanceId);
              return resolve();
            }

            if(!disableAgeCheck) {
              let snapshotAgeMsg = "Snapshot " + drSnapshotId + " is " + snapshotAgeHours.toFixed(1) +
                " hours old and has not been copied to the DR region";
              if(snapshotAgeHours > SNAPSHOT_COPY_AGE_ALERT) {
                logError(snapshotAgeMsg, dbInstanceId);
              }
              else if(snapshotAgeHours > SNAPSHOT_COPY_AGE_WARNING) {
                logWarning(snapshotAgeMsg, dbInstanceId);
              }
            }

            let params = {
              SourceDBSnapshotIdentifier: snapshot.DBSnapshotArn,
              TargetDBSnapshotIdentifier: drSnapshotId,
              CopyTags: true,
              SourceRegion: snapshot.AvailabilityZone.replace(/[a-z]$/, '')
            };
            if(snapshot.Encrypted) {
              params.KmsKeyId = DR_KMS_KEY;
            }

            logMessage('Copying snapshot ' + drSnapshotId + ' to DR region', dbInstanceId);
            rdsClientDr.copyDBSnapshot(params)
              .on('success', resolve)
              .on('error', function(err) {
                if(err.code == 'SnapshotQuotaExceeded') {
                  logWarning('Ignoring snapshot copy quota error: ' + JSON.stringify(err), dbInstanceId);
                  resolve();
                }
                else {
                  reject(err);
                }
              }).send();
          });
        }));
      });

      Promise.all(promises).then(function() {
        callback(null, 'success');
      }, function(err) {
        logError('Error encountered executing snapshot copy: ' + JSON.stringify(err), dbInstanceId);
        callback(err);
      });
    }
  }).on('error', function(err) {
    logError('Error encountered during snapshot enumeration: ' + JSON.stringify(err), dbInstanceId);
    callback(err);
  }).send();
};

var deleteOldSnapshots = function(dbInstanceId, rotationDate, callback) {
  let rdsClient = new aws.RDS({region: DR_REGION});
  let oldestAllowedSnapshot = dbInstanceId + '-' +
    dateFormat(rotationDate, 'yyyy-mm-dd-HH-MM');
  let oldSnapshots = [];

  logMessage('Kicking off snapshot deletion in DR region', dbInstanceId);
  logMessage('Finding snapshots older than ' + oldestAllowedSnapshot, dbInstanceId);

  rdsClient.describeDBSnapshots({
    DBInstanceIdentifier: dbInstanceId,
    IncludePublic: false,
    IncludeShared: false,
    SnapshotType: 'manual'
  }).on('success', function enumerateSnapshots(response) {
    response.data.DBSnapshots.forEach(function(snapshot) {
      if(snapshot.DBSnapshotIdentifier < oldestAllowedSnapshot) {
        oldSnapshots.push(snapshot.DBSnapshotIdentifier);
      }
    })

    if(response.hasNextPage()) {
      response.nextPage().on('success', enumerateSnapshots).send();
    }
    else {
      let promises = [];

      if(oldSnapshots.length == 0) {
        logMessage('No snapshots marked for deletion', dbInstanceId);
        return callback(null, 'success');
      }

      oldSnapshots.forEach(function(snapshotId) {
        promises.push(new Promise(function(resolve, reject) {
          logMessage('Deleting snapshot ' + snapshotId, dbInstanceId);
          rdsClient.deleteDBSnapshot({DBSnapshotIdentifier: snapshotId})
            .on('success', resolve)
            .on('error', reject)
            .send();
        }));
      });

      Promise.all(promises).then(function() {
        callback(null, 'success');
      }, function(err) {
        logError('Error encountered during snapshot deletion: ' + JSON.stringify(err), dbInstanceId);
        callback(err);
      });
    }
  }).on('error', function(err) {
    logError('Error encountered during snapshot enumeration: ' + JSON.stringify(err), dbInstanceId);
    callback(err);
  }).send();
};

var formatLogMessage = function(level, msg, dbInstanceId) {
  if(dbInstanceId) {
    return level + ': [' + dbInstanceId + '] ' + msg;
  }
  else {
    return level + ': ' + msg;
  }
};

var logMessage = function(msg, dbInstanceId) {
  console.log(formatLogMessage('INFO', msg, dbInstanceId));
};

var logWarning = function(msg, dbInstanceId) {
  let formattedMsg = formatLogMessage('WARN', msg, dbInstanceId);
  console.log(formattedMsg);
  if(SLACK_WARNINGS_CHANNEL) {
    sendNotification(SLACK_WARNINGS_CHANNEL, formattedMsg);
  }
};

var logError = function(msg, dbInstanceId) {
  let formattedMsg = formatLogMessage('ERR', msg, dbInstanceId);
  console.log(formattedMsg);
  if(SLACK_ALERTS_CHANNEL) {
    sendNotification(SLACK_ALERTS_CHANNEL, formattedMsg);
  }
};

var sendNotification = function(channel, msg) {
  if(!SLACK_WEBHOOK_URL) {
    return;
  }
  let webhook = new slackWebHook(SLACK_WEBHOOK_URL);
  let params = {
    username: 'RDSSnapshotCopier',
    iconEmoji: ':robot_face:',
    channel: channel,
    text: msg
  };
  webhook.send(params, function(err) {
    if(err) {
      console.log(formatLogMessage('ERR', 'Failed to send Slack notification: ' + msg, dbInstanceId));
    }
  });
};

exports.handler = function(event, context, callback) {
  logMessage('Received event: ' + JSON.stringify(event));

  let events = [];
  if(event.Records) {
    events = event.Records;
  }
  else {
    events = [event];
  }

  let rotationDate = new Date();
  rotationDate.setDate(rotationDate.getDate() - MAINTAIN_X_SNAPSHOTS);

  events.forEach(function(e) {
    try {
      if((e.command && e.command == 'initial_sync') || (e.source && e.source == 'aws.events')) {
        let disableAgeCheck = e.command && e.command == 'initial_sync';
        logMessage('Kicking off snapshot rotation for all instances');
        enumerateDBInstances(callback, function(dbInstance) {
          let dbInstanceId = dbInstance.DBInstanceIdentifier;
          if(dbInstance.BackupRetentionPeriod != 0) {
            rotateDisasterRecoverySnapshots(dbInstanceId, rotationDate, disableAgeCheck, callback);
          }
          else {
            logMessage('Skipping snapshot rotation b/c backups are disabled', dbInstanceId);
          }
        });
      }
      else if(e.EventSource && e.EventSource == 'aws:sns') {
        let message = JSON.parse(e.Sns.Message);
        if(message['Event ID'].match('#RDS-EVENT-0002$')) {
          let dbInstanceId = message['Source ID'];
          logMessage('Kicking off snapshot rotation for database', dbInstanceId);
          rotateDisasterRecoverySnapshots(dbInstanceId, rotationDate, true, callback);
        }
      }
      else if(e.command && e.command == 'initial_sync') {
        logMessage('Recieved command initial_sync');
        logMessage('Kicking off snapshot rotation for all instances');
        enumerateDBInstances(callback, function(dbInstance) {
          let dbInstanceId = dbInstance.DBInstanceIdentifier;
          if(dbInstance.BackupRetentionPeriod != 0) {
            rotateDisasterRecoverySnapshots(dbInstanceId, rotationDate, true, callback);
          }
          else {
            logMessage('Skipping snapshot rotation b/c backups are disabled', dbInstanceId);
          }
        });
      }
      else {
        logError('Encountered an unexpected event: ' + JSON.stringify(e));
      }
    }
    catch(err) {
      logError('Fatal error: ' + JSON.stringify(err));
    }
  });
};
