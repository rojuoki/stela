/**
 * JSON Logger for Stela
 * 
 * Requirements:
 * - All logs are JSON lines (jsonl) to stdout
 * - Machine-readable priority over human-readable
 * - No secrets (X tokens, cookies, Authorization headers) in logs
 * - Correlation via trace_id and job_id
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type ServiceType = 'api' | 'worker' | 'lib';

export type LogEvent = 
  | 'unlock_requested'
  | 'job_created'
  | 'job_started'
  | 'token_acquired'
  | 'x_request'
  | 'x_429'
  | 'job_suspended'
  | 'job_resumed'
  | 'job_succeeded'
  | 'job_failed'
  | 'token_released';

interface BaseLogFields {
  ts: string;                    // ISO timestamp
  level: LogLevel;              
  service: ServiceType;         // api | worker | lib
  env: string;                  // dev | test | prod
  trace_id: string;             // Correlation ID for unlock session
  job_id: string | null;        // Job ID if applicable
  worker_id: number;            // process.pid
  event: LogEvent;              // Fixed event name
}

interface XApiLogFields extends BaseLogFields {
  token_idx?: number;           // Token pool index
  token_fp?: string;            // Token fingerprint (last 6 chars)
  req_id?: string;              // HTTP request UUID
  endpoint?: string;            // e.g. "/2/tweets/search/all"
  rate_remaining?: number;      // Rate limit remaining
  rate_reset?: number;          // Rate limit reset timestamp
  attempt?: number;             // Retry attempt count
}

interface ErrorLogFields {
  err_name?: string;            // Error constructor name
  err_message?: string;         // Error message
  err_stack?: string;           // Stack trace
  error_code?: string;          // Structured error code
  http_status?: number;         // HTTP status code
  retry_after?: number;         // Seconds to wait (for 429)
}

type LogFields = BaseLogFields & XApiLogFields & ErrorLogFields & Record<string, any>;

class Logger {
  private logLevel: LogLevel;
  private env: string;
  private workerId: number;

  constructor() {
    this.logLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
    this.env = process.env.NODE_ENV || 'development';
    this.workerId = process.pid;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.logLevel);
  }

  private sanitizeFields(fields: Record<string, any>): Record<string, any> {
    const sanitized = { ...fields };
    
    // Remove or redact secret keys
    const secretKeys = ['token', 'authorization', 'cookie', 'password', 'secret', 'key'];
    
    for (const [key, value] of Object.entries(sanitized)) {
      const lowerKey = key.toLowerCase();
      if (secretKeys.some(secret => lowerKey.includes(secret))) {
        sanitized[key] = '[REDACTED]';
      }
      
      // Handle Error objects
      if (value instanceof Error) {
        delete sanitized[key];
        sanitized.err_name = value.constructor.name;
        sanitized.err_message = value.message;
        sanitized.err_stack = value.stack;
      }
    }
    
    return sanitized;
  }

  private formatLog(level: LogLevel, fields: Partial<LogFields>, message?: string): string {
    // Validate required fields
    if (!fields.trace_id) {
      throw new Error('trace_id is required for all logs');
    }
    if (!fields.service) {
      throw new Error('service is required for all logs');
    }
    if (!fields.event) {
      throw new Error('event is required for all logs');
    }

    const baseFields: BaseLogFields = {
      ts: new Date().toISOString(),
      level,
      service: fields.service as ServiceType,
      env: this.env,
      trace_id: fields.trace_id,
      job_id: fields.job_id || null,
      worker_id: this.workerId,
      event: fields.event as LogEvent,
    };

    const sanitizedFields = this.sanitizeFields(fields);
    const logEntry = {
      ...baseFields,
      ...sanitizedFields,
      ...(message && { message }),
    };

    return JSON.stringify(logEntry);
  }

  private output(logLine: string): void {
    console.log(logLine);
  }

  log(level: LogLevel, fields: Partial<LogFields>, message?: string): void {
    if (!this.shouldLog(level)) {
      return;
    }

    try {
      const logLine = this.formatLog(level, fields, message);
      this.output(logLine);
    } catch (error) {
      // Fallback to console.error if logging fails
      console.error('[Logger Error]', error, 'Original fields:', fields);
    }
  }

  debug(fields: Partial<LogFields>, message?: string): void {
    this.log('debug', fields, message);
  }

  info(fields: Partial<LogFields>, message?: string): void {
    this.log('info', fields, message);
  }

  warn(fields: Partial<LogFields>, message?: string): void {
    this.log('warn', fields, message);
  }

  error(fields: Partial<LogFields>, message?: string): void {
    this.log('error', fields, message);
  }

  // Convenience method for X API requests
  logXRequest(fields: {
    trace_id: string;
    job_id?: string;
    service: ServiceType;
    event: LogEvent;
    token_idx: number;
    token_fp: string;
    req_id: string;
    endpoint: string;
    attempt?: number;
    rate_remaining?: number;
    rate_reset?: number;
    http_status?: number;
    error_code?: string;
    retry_after?: number;
  }, message?: string): void {
    this.log('info', fields, message);
  }

  // Convenience method for job state changes
  logJobState(fields: {
    trace_id: string;
    job_id: string;
    service: ServiceType;
    event: LogEvent;
    status?: string;
    error_code?: string;
  }, message?: string): void {
    const level = fields.event === 'job_failed' ? 'error' : 'info';
    this.log(level, fields, message);
  }
}

// Singleton instance
export const logger = new Logger();

// Helper functions for generating IDs
export function generateTraceId(): string {
  return crypto.randomUUID();
}

export function generateRequestId(): string {
  return crypto.randomUUID();
}

export function getTokenFingerprint(token: string): string {
  if (!token || token.length < 6) {
    return 'unknown';
  }
  return token.slice(-6);
}