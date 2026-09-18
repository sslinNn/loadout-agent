#!/usr/bin/env node
import { buildCli } from "../dist/cli.js";
await buildCli().parseAsync(process.argv);
