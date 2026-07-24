#!/bin/bash

MODE=${1:-prod}

check_bundle_hard_link() {
  local source_inode bundle_inode

  source_inode=$(stat -c %i extension.js)
  bundle_inode=$(stat -c %i extension-bundle.js 2>/dev/null)

  if [[ "${source_inode}" == "${bundle_inode}" ]]; then
    echo "ERROR: extension-bundle.js is a hard link to extension.js - remove the hard link before building a release bundle." >&2
    return 1
  fi
}

check_bundle_hard_link

case "${MODE}" in
  dev)
    webpack --mode none
    ;;
  prod)
    webpack --mode production
    ;;
  *)
    echo "Usage: bash ./build-bundle.sh [dev|prod]" >&2
    exit 1
    ;;
esac
