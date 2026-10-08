/**
 * IMAP read and SMTP send for named accounts. Reading never marks a message
 * as seen unless asked; sending always uses the account's own address.
 *
 * accounts: { personal: { address, password } }, allowedDomains: ['example.com']
 */
export class MailClient {
  constructor({ host, imapPort = 993, smtpPort = 587, accounts, allowedDomains = [], imapFactory, smtpFactory }) {
    this.host = host;
    this.imapPort = imapPort;
    this.smtpPort = smtpPort;
    this.accounts = accounts;
    this.allowedDomains = allowedDomains.map((domain) => domain.toLowerCase());
    this.imapFactory = imapFactory || defaultImapFactory;
    this.smtpFactory = smtpFactory || defaultSmtpFactory;
  }

  async folders(accountName) {
    return this.withImap(accountName, async (client) => (await client.list()).map((folder) => ({
      path: folder.path,
      name: folder.name,
      specialUse: folder.specialUse || null,
    })));
  }

  async list(accountName, { mailbox = 'INBOX', limit = 25, unseen = false } = {}) {
    return this.withImap(accountName, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const total = client.mailbox.exists;
        if (total === 0) {
          return [];
        }
        const start = Math.max(1, total - Math.max(limit * 3, limit) + 1);
        const messages = [];
        for await (const message of client.fetch(`${start}:*`, {
          uid: true, envelope: true, flags: true, internalDate: true, size: true,
        })) {
          if (unseen && message.flags?.has('\\Seen')) {
            continue;
          }
          messages.push(normaliseMessage(message));
        }
        return messages.slice(-limit).reverse();
      } finally {
        lock.release();
      }
    });
  }

  async search(accountName, query, { mailbox = 'INBOX', limit = 25 } = {}) {
    return this.withImap(accountName, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const uids = await client.search({ or: [{ subject: query }, { from: query }, { body: query }] }, { uid: true });
        const wanted = (uids || []).slice(-limit);
        if (!wanted.length) {
          return [];
        }
        const messages = [];
        for await (const message of client.fetch(wanted.join(','), {
          uid: true, envelope: true, flags: true, internalDate: true, size: true,
        }, { uid: true })) {
          messages.push(normaliseMessage(message));
        }
        return messages.reverse();
      } finally {
        lock.release();
      }
    });
  }

  async read(accountName, uid, { mailbox = 'INBOX', markSeen = false } = {}) {
    return this.withImap(accountName, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const message = await client.fetchOne(Number(uid), {
          uid: true, envelope: true, flags: true, internalDate: true, source: true,
        }, { uid: true });
        if (!message) {
          throw new Error(`Message IMAP introuvable : ${uid}`);
        }
        if (markSeen) {
          await client.messageFlagsAdd(Number(uid), ['\\Seen'], { uid: true });
        }
        return { ...normaliseMessage(message), source: message.source?.toString('utf8') || '' };
      } finally {
        lock.release();
      }
    });
  }

  async send(accountName, message) {
    const account = this.account(accountName);
    if (!message.to || !message.subject || (!message.text && !message.html)) {
      throw new Error('Un destinataire, un sujet et un corps texte ou HTML sont obligatoires.');
    }
    if (message.from && normaliseAddress(message.from) !== normaliseAddress(account.address)) {
      throw new Error(`L’expéditeur doit être ${account.address}.`);
    }
    const transport = await this.smtpFactory(this.smtpConfig(account));
    await transport.verify();
    return transport.sendMail({ ...message, from: account.address });
  }

  async verify(accountName) {
    const account = this.account(accountName);
    await this.withImap(accountName, async () => undefined);
    const smtp = await this.smtpFactory(this.smtpConfig(account));
    await smtp.verify();
    return { account: account.address, imap: true, smtp: true };
  }

  account(name) {
    const account = this.accounts[name];
    if (!account) {
      throw new Error(`Boîte inconnue : ${name}. Boîtes configurées : ${Object.keys(this.accounts).join(', ')}.`);
    }
    if (!account.address || !account.password) {
      throw new Error(`Identifiants incomplets pour la boîte ${name}.`);
    }
    const domain = account.address.split('@').pop().toLowerCase();
    if (this.allowedDomains.length && !this.allowedDomains.includes(domain)) {
      throw new Error(`Adresse hors des domaines autorisés : ${account.address}`);
    }
    return account;
  }

  async withImap(accountName, work) {
    const account = this.account(accountName);
    const client = await this.imapFactory(this.imapConfig(account));
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  imapConfig(account) {
    return {
      host: this.host,
      port: this.imapPort,
      secure: true,
      auth: { user: account.address, pass: account.password },
      logger: false,
    };
  }

  smtpConfig(account) {
    return {
      host: this.host,
      port: this.smtpPort,
      secure: this.smtpPort === 465,
      requireTLS: this.smtpPort !== 465,
      auth: { user: account.address, pass: account.password },
    };
  }
}

async function defaultImapFactory(config) {
  const { ImapFlow } = await import('imapflow');
  return new ImapFlow(config);
}

async function defaultSmtpFactory(config) {
  const nodemailer = await import('nodemailer');
  return nodemailer.default.createTransport(config);
}

function normaliseMessage(message) {
  return {
    uid: message.uid,
    date: message.internalDate?.toISOString?.() || null,
    subject: message.envelope?.subject || '',
    from: formatAddresses(message.envelope?.from),
    to: formatAddresses(message.envelope?.to),
    seen: message.flags?.has('\\Seen') || false,
    size: message.size || null,
  };
}

function formatAddresses(addresses = []) {
  return addresses.map((address) => ({
    name: address.name || '',
    address: address.address || `${address.mailbox || ''}@${address.host || ''}`,
  }));
}

function normaliseAddress(address) {
  const match = String(address).match(/<([^>]+)>/);
  return (match?.[1] || String(address)).trim().toLowerCase();
}
