#!/usr/bin/env bun
import { gatewayMain } from '../src/gateway/host.js'

gatewayMain(process.argv.slice(2))
