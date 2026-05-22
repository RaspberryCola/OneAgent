import React, { useState } from "react";
import { Loader2, KeyRound } from "lucide-react";
import { useAppStore } from "../lib/store";

export function LoginScreen() {
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const login = useAppStore((state) => state.login);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    
    setIsSubmitting(true);
    setError(null);
    
    try {
      const success = await login(password);
      if (!success) {
        setError("Invalid password. Please try again.");
      }
    } catch (err: any) {
      setError(err.message || "Failed to login. Connection error.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex h-screen w-full items-center justify-center bg-snow px-4">
      <div className="w-full max-w-sm rounded-container border border-border-light bg-pure-white p-8 shadow-none">
        <div className="flex flex-col items-center mb-8">
          <div className="flex h-12 w-12 items-center justify-center rounded-interactive bg-pure-black text-pure-white mb-4">
            <KeyRound className="w-6 h-6" />
          </div>
          <h1 className="text-card font-medium text-pure-black tracking-tight font-display mb-1">
            OneAgent
          </h1>
          <p className="text-caption text-stone text-center">
            Enter password to access your agentic workspace
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label 
              htmlFor="password" 
              className="block text-small font-medium text-near-black mb-1.5"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              disabled={isSubmitting}
              className="w-full rounded-interactive border border-border-light bg-snow px-3.5 py-2 text-chat text-pure-black placeholder:text-silver focus:border-pure-black focus:bg-pure-white focus:outline-none disabled:opacity-50"
              autoFocus
            />
          </div>

          {error && (
            <div className="text-small text-rose-500 font-medium bg-rose-50 border border-rose-500/10 rounded-interactive p-3">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting || !password.trim()}
            className="w-full flex justify-center items-center gap-2 bg-pure-black text-pure-white px-4 py-2.5 rounded-interactive text-chat font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Connecting...
              </>
            ) : (
              "Sign In"
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
