import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Bulk URL Health Checker",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="app-header">
          <div className="app-header__inner">
            <a href="/" className="app-header__link">
              <span className="app-header__mark" aria-hidden="true">
                ⌁
              </span>
              <h1 className="app-header__title">Bulk URL Health Checker</h1>
            </a>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
