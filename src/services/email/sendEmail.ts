import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { env } from '../../config/env.js';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';

// E-mail leaves as a message to an SNS topic, which something else turns into mail: the same message the old API sends ({ fromName, from, to, subject, body }).
// Nothing is sent without the topic (`SNS_ARN`); the credentials are the server's role in production and AWS_* variables locally.

const FROM = 'care@fitanalytica.com';

let client: SNSClient | undefined;
const sns = () => (client ??= new SNSClient({ region: env().sns.region }));

export interface Email {
  to: string;
  subject: string;
  body: string;
  /** @default care@fitanalytica.com */
  from?: string;
}

/** Whether e-mail can be sent from here. */
export const emailConfigured = (): boolean => Boolean(env().sns.topicArn);

/** Sends one e-mail. 503 `EMAIL_UNAVAILABLE` when it is not set up or the service does not take it. */
export async function sendEmail(mail: Email): Promise<void> {
  const topicArn = env().sns.topicArn;
  if (!topicArn) throw errors.Unavailable('E-mail is not set up on the server', ErrorCode.EMAIL_UNAVAILABLE);
  const message = { fromName: 'fitAnalytica', from: mail.from ?? FROM, to: mail.to, subject: mail.subject, body: mail.body };
  try {
    await sns().send(new PublishCommand({ TopicArn: topicArn, Message: JSON.stringify(message) }));
  } catch (e) {
    throw errors.Unavailable(`The e-mail could not be sent: ${e instanceof Error ? e.message : 'unknown error'}`, ErrorCode.EMAIL_UNAVAILABLE);
  }
}
