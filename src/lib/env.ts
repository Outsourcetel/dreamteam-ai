const required = (key: string): string => {
  const val = import.meta.env[key] as string | undefined;
  if (!val) {
    throw new Error(
      `Missing required environment variable: ${key}. ` +
      `Ensure it is set in your .env file locally or in Vercel project settings.`
    );
  }
  return val;
};

export const SUPABASE_URL = required('VITE_SUPABASE_URL');
export const SUPABASE_ANON_KEY = required('VITE_SUPABASE_ANON_KEY');
