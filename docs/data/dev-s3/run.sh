#!/bin/sh
# Runs MinIO, a local stand-in for S3, on :9000 (console on :9001). Data lives outside the repo. Leave it running in its own terminal.
#   brew install minio        (once)
#   sh docs/data/dev-s3/run.sh
export MINIO_ROOT_USER=minioadmin
export MINIO_ROOT_PASSWORD=minioadmin
mkdir -p "$HOME/.fitanalytica-minio"
exec minio server "$HOME/.fitanalytica-minio" --address :9000 --console-address :9001
