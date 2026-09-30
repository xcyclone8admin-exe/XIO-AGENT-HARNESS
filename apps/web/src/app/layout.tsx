import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PRODUCT_NAME, PRODUCT_TAGLINE } from '@xyra/brand';
import { ThemeProvider } from '@xyra/ui';
import '@xyra/ui/styles.css';
import { LocalProvider } from './local-provider';

export const metadata: Metadata = { title: PRODUCT_NAME, description: PRODUCT_TAGLINE };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <LocalProvider>{children}</LocalProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
