/**
 * Creates the admin account, or gives it a new random password.
 *
 *   npm run create-admin
 *
 * Prints the new password once. Use it to sign in to the admin panel.
 * (Without a terminal, use "Forgot password?" in the panel with the recovery code.)
 */
import { issueNewAdminPassword } from '../auth/adminPassword.js';
import { pool } from '../db/index.js';

try {
  const result = await issueNewAdminPassword();
  console.log(result.created ? 'Admin account created.' : 'Admin password reset.');
  console.log(`\n  New admin password: ${result.password}\n`);
  console.log('Save it in a password manager. It will not be shown again.');
} catch (error) {
  console.error('Could not set the admin password:', (error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
