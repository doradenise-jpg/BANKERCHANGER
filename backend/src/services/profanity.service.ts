/**
 * Profanity filter service with support for bad-words library and admin custom blocked words (Issue #677).
 */

const DEFAULT_BLOCKED_WORDS = new Set<string>([
  'profanity',
  'offensive',
  'abuse',
  'scam',
  'hate',
  'shitty',
  'fuck',
  'shit',
  'bitch',
  'asshole',
  'bastard',
  'crap',
  'damn',
]);

const customBlockedWords = new Set<string>();

let badWordsFilter: any = null;
try {
  const Filter = require('bad-words');
  badWordsFilter = new Filter();
} catch {
  // bad-words fallback using internal wordlist
}

/**
 * Checks if a string contains profane or blocked content.
 */
export function isProfaneContent(text: string): boolean {
  if (!text || typeof text !== 'string') return false;

  const lower = text.toLowerCase();

  // Check bad-words filter if available
  if (badWordsFilter) {
    try {
      if (badWordsFilter.isProfane(text)) {
        return true;
      }
    } catch {
      // Ignore filter error and fallback
    }
  }

  // Check default and custom blocked words
  for (const word of DEFAULT_BLOCKED_WORDS) {
    const regex = new RegExp(`\\b${word}\\b`, 'i');
    if (regex.test(lower)) {
      return true;
    }
  }

  for (const word of customBlockedWords) {
    const regex = new RegExp(`\\b${word}\\b`, 'i');
    if (regex.test(lower)) {
      return true;
    }
  }

  return false;
}

/**
 * Add custom words to blocked list (Admin feature).
 */
export function addBlockedWords(words: string | string[]): string[] {
  const list = Array.isArray(words) ? words : [words];
  for (const w of list) {
    const normalized = w.trim().toLowerCase();
    if (normalized.length > 0) {
      customBlockedWords.add(normalized);
      if (badWordsFilter) {
        try {
          badWordsFilter.addWords(normalized);
        } catch {
          // Fallback
        }
      }
    }
  }
  return Array.from(customBlockedWords);
}

/**
 * Return currently registered custom blocked words.
 */
export function getBlockedWords(): string[] {
  return Array.from(customBlockedWords);
}

/**
 * Reset custom blocked words (test isolation helper).
 */
export function resetBlockedWords(): void {
  customBlockedWords.clear();
}
