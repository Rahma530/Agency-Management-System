import { createClient, type User } from '@supabase/supabase-js';

const s = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const email = 'headtechnical@kesraa.com';

const { data: users } = await s.auth.admin.listUsers();
const user = (users?.users as User[] | undefined)?.find(u => u.email === email);

if (!user) {
  console.log('User not found in auth');
  process.exit(1);
}

const { data, error } = await s.auth.admin.generateLink({
  type: 'recovery',
  email,
  options: { redirectTo: 'http://localhost:3000' }
});

if (error) {
  console.error('Error:', error.message);
} else {
  console.log(`\n✅ Recovery Link for ${email}:\n`);
  console.log(data.properties?.action_link);
}
