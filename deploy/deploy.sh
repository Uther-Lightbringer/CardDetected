#!/usr/bin/env bash
# 一键部署到云服务器：git archive 打包已提交的源码 → 传过去 → docker compose 重建
# 用法：npm run deploy           （默认远端 aliyun，目录 ~/cardetect）
#       DEPLOY_HOST=xxx DEPLOY_DIR=/opt/xx npm run deploy
set -euo pipefail

REMOTE=${DEPLOY_HOST:-aliyun}
# 相对路径（相对远端 home），避免 ~ 被本地 shell 提前展开
DIR=${DEPLOY_DIR:-cardetect}

if [[ -n $(git status --porcelain) ]]; then
  echo "⚠️  有未提交的改动，部署内容将只包含已提交（HEAD）的代码"
fi

echo "== 打包源码（git archive HEAD）并传输到 $REMOTE:$DIR =="
git archive --format=tar.gz HEAD | ssh "$REMOTE" "mkdir -p $DIR && tar -xzf - -C $DIR"

echo "== 远端构建并重启容器 =="
ssh "$REMOTE" "cd $DIR && docker compose up -d --build"

echo "== 完成 =="
