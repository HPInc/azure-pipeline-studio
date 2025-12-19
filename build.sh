#!/bin/bash

# Load nvm and use Node 20
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use 20 2>/dev/null || echo "Warning: nvm not available or Node 20 not installed"

unset GITHUB_TOKEN

INSTALL=0
PRE_RELEASE=0
RELEASE=1
DEVELOPMENT=0

while getopts ":iprd" OPT; do
  case ${OPT} in
    i)
      INSTALL=1
      ;;
    p)
      PRE_RELEASE=1
      ;;
    r)
      RELEASE=1
      ;;
    d)
      DEVELOPMENT=1
      ;;
    *)
      usage
      ;;
  esac
done

if [ ${INSTALL} -eq 1 ]; then
  npm install -g @vscode/vsce
  npm install -g webpack-cli
  npm install -g webpack
  npm install -g prettier
fi

npm install

# Build with webpack
# Webpack outputs to extension-bundle.js to avoid overwriting source
if [ ${DEVELOPMENT} -eq 1 ]; then
  npm run build:dev
else
  npm run build:prod
fi

# Package the extension
rm -f ./*.vsix

#VERSION=$(jq -Mr .version package.json)
if [ ${RELEASE} -eq 1 ]; then
  if [ ${PRE_RELEASE} -eq 1 ]; then
    vsce package --pre-release
  else
    vsce package
  fi
  #code --install-extension "ado-pipeline-navigator-${VERSION}.vsix"
  #vsce publish --pre-release
fi
