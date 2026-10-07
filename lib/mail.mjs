// Sending sign-in links. SMTP_URL (smtp://user:pass@host:587) and MAIL_FROM set it up; any mail service
// that speaks SMTP works (Postmark, Resend, SES, Mailgun, your own server). Without it, links go to the log.
export async function createMailer(env = process.env) {
  if (!env.SMTP_URL) {
    return { ready: false, sent: [], async send(m) { this.sent.push(m); console.log(`chat: no SMTP_URL, so here is the email to ${m.to}:\n${m.text}`); } };
  }
  const { default: nodemailer } = await import('nodemailer');
  const t = nodemailer.createTransport(env.SMTP_URL);
  return { ready: true, async send(m) { await t.sendMail({ from: env.MAIL_FROM || 'chat@localhost', ...m }); } };
}
