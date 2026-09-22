// Netlify Edge Functions expose environment variables through the `Netlify` global.
// The AI Gateway credentials are injected per request (the key is a JWT that lives
// about 60 seconds), so every read must happen at request time, never at module load.
declare const Netlify: { env: { get(key: string): string | undefined } };

export const env = (key: string): string | undefined => {
  const v = Netlify.env.get(key);
  return v === undefined || v === "" ? undefined : v;
};

export const flag = (key: string, fallback: boolean): boolean => {
  const v = env(key);
  if (v === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(v.toLowerCase());
};
