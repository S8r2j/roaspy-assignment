"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { API_BASE_PUBLIC } from "../lib/api";
import type { CreateBatchResponse } from "@roaspy/shared";

type Mode = "paste" | "upload";

/** Batch submission form: paste-URLs and upload-CSV as two tabs of the
 * same `POST /batches` submission, redirecting to the new batch's detail
 * page on success. Both submit paths share the same error handling and
 * "submitting" disabled-state pattern. */
export function BatchSubmitForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("paste");
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Submits the pasted-URLs textarea as `{ urls: text }` JSON. */
  async function submitText(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE_PUBLIC}/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: text }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to submit batch");
      const data: CreateBatchResponse = await res.json();
      router.push(`/batches/${data.batchId}`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  /** Submits the selected CSV file as multipart/form-data. */
  async function submitFile(e: React.FormEvent) {
    e.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setError("Choose a CSV file first.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`${API_BASE_PUBLIC}/batches`, { method: "POST", body: formData });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to submit batch");
      const data: CreateBatchResponse = await res.json();
      router.push(`/batches/${data.batchId}`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setFileName(null);
    }
  }

  /** Switches between the paste-URLs and upload-CSV tabs, clearing any
   * error from the previous tab's submission attempt. */
  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  return (
    <section className="card" aria-labelledby="submit-heading">
      <h2 id="submit-heading" style={{ marginTop: 0 }}>
        Submit a batch
      </h2>

      <div className="tab-group" role="tablist" aria-label="URL submission method">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "paste"}
          className="tab-btn"
          onClick={() => switchMode("paste")}
        >
          Paste URLs
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "upload"}
          className="tab-btn"
          onClick={() => switchMode("upload")}
        >
          Upload CSV
        </button>
      </div>

      {mode === "paste" ? (
        <form onSubmit={submitText}>
          <label htmlFor="urls-textarea" className="field-hint" style={{ display: "block", marginBottom: "0.35rem" }}>
            One URL per line, e.g. <code>https://example.com</code>
          </label>
          <textarea
            id="urls-textarea"
            className="url-textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"https://example.com\nhttps://www.iana.org"}
            rows={6}
          />
          <div style={{ marginTop: "0.75rem" }}>
            <button type="submit" className="btn btn-primary" disabled={submitting || text.trim().length === 0}>
              {submitting ? "Submitting…" : "Submit URLs"}
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={submitFile}>
          <p className="field-hint" style={{ marginBottom: "0.5rem" }}>
            A .csv file with one URL per row (a single column, no header row). Extra columns on a
            line are ignored — only the first column is read as the URL.{" "}
            <a href="/sample-urls.csv" download>
              Download a sample CSV
            </a>{" "}
            to see the expected format.
          </p>
          <div className="dropzone">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
              disabled={submitting}
            />
            {fileName && (
              <p className="field-hint" style={{ marginTop: "0.5rem" }}>
                Selected: {fileName}
              </p>
            )}
          </div>
          <div style={{ marginTop: "0.75rem" }}>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? "Submitting…" : "Upload & submit"}
            </button>
          </div>
        </form>
      )}

      {error && <p className="error-banner">{error}</p>}
    </section>
  );
}
