import pino from 'pino'
import { env } from './env.js'

/**
 * Structured JSON logger. pm2 captures stdout to its log files, so plain JSON
 * is the most portable format (pipe through `pino-pretty` locally if desired).
 */
export const logger = pino({ level: env.logLevel })

export type Logger = typeof logger
