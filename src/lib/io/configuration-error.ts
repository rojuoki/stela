/** A safe configuration failure that an IO route may explain to a local developer. */
export class IoConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IoConfigurationError";
  }
}

export function ioConfigurationMessage(): string {
  return process.env.NODE_ENV === "production"
    ? "The IO service is temporarily unavailable"
    : "IO開発データベースに接続できません。STELA_IO_DATABASE_URL と STELA_IO_AUTH_SECRET を .env.local に設定して、開発サーバを再起動してください。";
}
