/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_RPC: process.env.NEXT_PUBLIC_RPC ?? "http://127.0.0.1:8899",
    NEXT_PUBLIC_INDEXER: process.env.NEXT_PUBLIC_INDEXER ?? "http://127.0.0.1:8787",
    NEXT_PUBLIC_MERIDIAN: process.env.NEXT_PUBLIC_MERIDIAN ?? "HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD",
  },
};
