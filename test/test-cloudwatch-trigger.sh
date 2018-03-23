#!/bin/bash

source ../config

lambda-local -l ../src/index.js -h handler -t 300 \
  -e fixtures/cloudwatch-scheduled-event.json
