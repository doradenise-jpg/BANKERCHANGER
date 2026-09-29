import { NextResponse } from 'next/server';

export async function GET() {
  const now = Date.now();
  return NextResponse.json({
    serverTime: now,
    iso: new Date(now).toISOString(),
  });
}
