import { createClient } from '@supabase/supabase-js';

const s = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const { data } = await s
  .from('users')
  .select('name,email,role')
  .in('role', ['head_of_technical', 'executive']);

console.log(JSON.stringify(data, null, 2));
