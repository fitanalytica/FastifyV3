import { test, expect, vi, afterEach } from 'vitest';

// The e-mail leaves as a message to an SNS topic (the same shape the old API sends). SNS is a stand-in.
const sns = vi.hoisted(() => ({ sent: [] as { TopicArn: string; Message: string }[], fail: false, region: '' }));
vi.mock('@aws-sdk/client-sns', () => ({
  SNSClient: class {
    constructor(o: { region: string }) { sns.region = o.region; }
    async send(command: { input: { TopicArn: string; Message: string } }) {
      if (sns.fail) throw new Error('AccessDenied');
      sns.sent.push(command.input);
      return { MessageId: 'm1' };
    }
  },
  PublishCommand: class { constructor(public input: { TopicArn: string; Message: string }) {} },
}));

import { emailConfigured, sendEmail } from '../../../src/services/email/sendEmail.js';

afterEach(() => { vi.unstubAllEnvs(); sns.sent = []; sns.fail = false; });

test('nothing is sent without a topic: 503 EMAIL_UNAVAILABLE and no call to SNS', async () => {
  vi.stubEnv('SNS_ARN', '');
  expect(emailConfigured()).toBe(false);
  await expect(sendEmail({ to: 'a@b.c', subject: 's', body: 'b' })).rejects.toMatchObject({ statusCode: 503, code: 'EMAIL_UNAVAILABLE' });
  expect(sns.sent).toEqual([]);
});

test('the message to the topic is { fromName, from, to, subject, body }, from care@ unless said', async () => {
  vi.stubEnv('SNS_ARN', 'arn:aws:sns:us-east-1:123456789012:mail');
  expect(emailConfigured()).toBe(true);
  await sendEmail({ to: 'asha@example.com', subject: 'Hello', body: 'Body text' });
  expect(sns.sent).toHaveLength(1);
  expect(sns.sent[0].TopicArn).toBe('arn:aws:sns:us-east-1:123456789012:mail');
  expect(JSON.parse(sns.sent[0].Message)).toEqual({ fromName: 'fitAnalytica', from: 'care@fitanalytica.com', to: 'asha@example.com', subject: 'Hello', body: 'Body text' });
  await sendEmail({ to: 'x@y.z', subject: 's', body: 'b', from: 'team@fitanalytica.com' });
  expect(JSON.parse(sns.sent[1].Message).from).toBe('team@fitanalytica.com');
  expect(sns.region).toBe('us-east-1');
});

test('SNS refusing it is a 503 that says why; nothing about the topic leaks into the message', async () => {
  vi.stubEnv('SNS_ARN', 'arn:aws:sns:us-east-1:123456789012:mail');
  sns.fail = true;
  await expect(sendEmail({ to: 'a@b.c', subject: 's', body: 'b' })).rejects.toMatchObject({ statusCode: 503, code: 'EMAIL_UNAVAILABLE', message: expect.stringContaining('AccessDenied') });
});
