// Plain module (not 'use client'), so the server layout gets real values, not client references.

/**
 * Development only, until feature 5 replaces it with the language switch. Inlined at
 * build time, so production builds carry neither the switch nor the head script.
 */
export const DIRECTION_SWITCH = process.env.NODE_ENV !== 'production';

export const DIRECTION_STORAGE_KEY = 'ss_dir';

/** Runs in `<head>` before first paint so a right to left page never flashes left to right. */
export const directionScript = `try{var d=localStorage.getItem('${DIRECTION_STORAGE_KEY}');if(d==='rtl'||d==='ltr')document.documentElement.dir=d}catch(e){}`;
