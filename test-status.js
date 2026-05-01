const { createClient } = require('@supabase/supabase-js');
const supabase = createClient('https://irvsdwzuzznzhhwuentt.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlydnNkd3p1enpuemhod3VlbnR0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzMDIzMTgsImV4cCI6MjA4ODg3ODMxOH0.o1nnWf_LpSvEPhZcUow0GAgbALI28S_58NrDyUEBO0g');
async function test() {
  const { data } = await supabase.from('commands').select('*').order('created_at', { ascending: false }).limit(2);
  console.log(data);
}
test();
