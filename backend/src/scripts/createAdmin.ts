/**
 * Creates an admin account, or resets an existing admin's password.
 *
 *   npm run create-admin -- you@example.com "Your Name"
 *
 * You are asked for the password (it is not shown). For scripts, set ADMIN_PASSWORD instead.
 */
import { createInterface } from 'node:readline';
import { hashSecret } from '../auth/passwords.js';
import { pool, query } from '../db/index.js';

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let asked = false;
    out._writeToOutput = (s: string) => {
      if (!asked) {
        out.output.write(s);
        asked = true;
      } else if (s.includes('\n')) {
        out.output.write('\n');
      } else {
        out.output.write('*');
      }
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const [emailArg, ...nameParts] = process.argv.slice(2);
  const email = emailArg?.trim().toLowerCase();
  const name = nameParts.join(' ').trim() || 'Admin';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('Usage: npm run create-admin -- you@example.com "Your Name"');
    process.exit(1);
  }

  let password = process.env.ADMIN_PASSWORD ?? '';
  if (!password) {
    password = await askHidden('Admin password (12+ characters): ');
    const again = await askHidden('Type it again: ');
    if (password !== again) {
      console.error('The passwords do not match.');
      process.exit(1);
    }
  }
  if (password.length < 12) {
    console.error('Use at least 12 characters for an admin password.');
    process.exit(1);
  }

  const existing = await query<{ id: string; role: string }>(
    'SELECT id, role FROM users WHERE email = $1',
    [email]
  );
  const hash = await hashSecret(password);
  if (existing.rows[0]) {
    if (existing.rows[0].role !== 'admin') {
      console.error(`${email} is already a ${existing.rows[0].role} account. Use a different email for the admin.`);
      process.exit(1);
    }
    await query('UPDATE users SET password_hash = $1, name = $2, updated_at = NOW() WHERE id = $3', [
      hash,
      name,
      existing.rows[0].id,
    ]);
    console.log(`Password reset for admin ${email}.`);
  } else {
    await query(`INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, 'admin')`, [
      email,
      hash,
      name,
    ]);
    console.log(`Admin ${email} created.`);
  }
  await pool.end();
}

main().catch(async (error) => {
  console.error('Could not create the admin:', error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
