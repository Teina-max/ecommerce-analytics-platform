/**
 * Telegram Bot Utilities
 * Shared utilities for Telegram bot Edge Functions
 */

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  entities?: TelegramMessageEntity[];
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

/**
 * Send a message via Telegram Bot API
 */
export async function sendMessage(
  chatId: number,
  text: string,
  options: {
    parseMode?: "HTML" | "Markdown" | "MarkdownV2";
    replyMarkup?: any;
  } = {}
): Promise<boolean> {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!botToken) {
    console.error("TELEGRAM_BOT_TOKEN not configured");
    return false;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: options.parseMode || "HTML",
          reply_markup: options.replyMarkup,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("Telegram API error:", error);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Failed to send Telegram message:", error);
    return false;
  }
}

/**
 * Answer a callback query
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string
): Promise<boolean> {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!botToken) return false;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/answerCallbackQuery`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          text,
        }),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Format currency in EUR
 */
export function formatEUR(amount: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
  }).format(amount);
}

/**
 * Format date in French
 */
export function formatDateFR(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("fr-FR", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Get today's date in YYYY-MM-DD format (Paris timezone)
 */
export function getTodayDate(): string {
  const now = new Date();
  // Adjust for Paris timezone (UTC+1 or UTC+2 during DST)
  const parisTime = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Paris" }));
  return parisTime.toISOString().split("T")[0];
}

/**
 * Store name mappings
 */
export const STORE_NAMES: Record<number, string> = {
  1: "Store-A",
  2: "Store-B",
  3: "Store-C",
  5: "Store-E",
  6: "Store-F",
  39: "Store-D",
};

export const STORE_ALIASES: Record<string, number> = {
  "store-a": 1,
  sa: 1,
  "store-b": 2,
  sb: 2,
  "store-c": 3,
  sc: 3,
  "store-d": 39,
  sd: 39,
  "store-e": 5,
  se: 5,
  "store-f": 6,
  sf: 6,
};

/**
 * Parse store from user input
 */
export function parseStore(input: string): number | null {
  const normalized = input.toLowerCase().trim();

  // Try alias first
  if (STORE_ALIASES[normalized]) {
    return STORE_ALIASES[normalized];
  }

  // Try numeric ID
  const numId = parseInt(normalized);
  if (!isNaN(numId) && STORE_NAMES[numId]) {
    return numId;
  }

  return null;
}

/**
 * Parse date from user input
 */
export function parseDate(input: string): string | null {
  const normalized = input.trim();

  // Today
  if (["aujourd'hui", "aujourdhui", "today", "auj"].includes(normalized.toLowerCase())) {
    return getTodayDate();
  }

  // Yesterday
  if (["hier", "yesterday"].includes(normalized.toLowerCase())) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday.toISOString().split("T")[0];
  }

  // YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized;
  }

  // DD/MM/YYYY format (French)
  const frMatch = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (frMatch) {
    const [, day, month, year] = frMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  // DD/MM format (current year)
  const shortFrMatch = normalized.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (shortFrMatch) {
    const [, day, month] = shortFrMatch;
    const year = new Date().getFullYear();
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  return null;
}
