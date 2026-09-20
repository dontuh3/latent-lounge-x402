#!/usr/bin/env bash
# Compatibility wrapper; the gate itself is portable Node.js.
exec node "$(dirname "$0")/gate.mjs"
