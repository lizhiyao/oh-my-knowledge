#!/bin/sh
# Evaluation Core custom-executor v1 fixture. Each attempt gets one request and one response.
IFS= read -r _request
printf '%s\n' '{"schemaVersion":"omk.custom-executor-exchange/v1","resultStatus":"completed","output":{"value":"fixture output","classification":"public"}}'
