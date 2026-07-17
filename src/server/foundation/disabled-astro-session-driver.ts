import type { SessionDriver } from 'astro';

const ERROR_MESSAGE = 'Astro sessions are disabled; use Orbit D1 sessions.';

export default function disabledAstroSessionDriver(): SessionDriver {
  const reject = async (): Promise<never> => {
    throw new Error(ERROR_MESSAGE);
  };

  return {
    getItem: reject,
    setItem: reject,
    removeItem: reject,
  };
}
