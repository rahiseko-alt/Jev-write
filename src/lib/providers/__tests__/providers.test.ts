import { describe, it, expect } from "vitest";
import { getLLMProvider, OpenAILLMProvider } from "../llm";
import { getJEVClient, HTTPJEVClient } from "../jev";
import {
  getGoogleFactCheckClient,
  getFactCheckClient,
  HTTPGoogleFactCheckClient,
} from "../google-factcheck";
import { getSearchProvider, TavilySearchProvider } from "../search";
import { getFetchProvider, HTTPFetchProvider } from "../fetch";

/**
 * Which provider the application builds, and what it does when a credential
 * is missing. There is nothing to stand in for one: it says so and stops.
 */

describe("LLM Provider", () => {

  it("factory reports a missing credential rather than standing in for one", () => {
    const saved = {
      anthropic: process.env.ANTHROPIC_API_KEY,
      claude: process.env.CLAUDE_API_KEY,
      openai: process.env.OPENAI_API_KEY,
      lower: process.env.openai,
      lowerAnthropic: process.env.anthropic,
    };
    for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "OPENAI_API_KEY", "openai", "anthropic"]) {
      delete process.env[key];
    }
    try {
      expect(() => getLLMProvider({ apiKey: "" })).toThrow();
    } finally {
      if (saved.anthropic) process.env.ANTHROPIC_API_KEY = saved.anthropic;
      if (saved.claude) process.env.CLAUDE_API_KEY = saved.claude;
      if (saved.openai) process.env.OPENAI_API_KEY = saved.openai;
      if (saved.lower) process.env.openai = saved.lower;
      if (saved.lowerAnthropic) process.env.anthropic = saved.lowerAnthropic;
    }
  });

  it("factory returns OpenAILLMProvider when API key is provided", () => {
    const provider = getLLMProvider({ apiKey: "sk-testkey123" });
    expect(provider).toBeInstanceOf(OpenAILLMProvider);
  });
});

describe("JEV Provider", () => {

  it("factory returns HTTPJEVClient when URL is provided", () => {
    const client = getJEVClient({ apiUrl: "https://jev.internal.example.com" });
    expect(client).toBeInstanceOf(HTTPJEVClient);
  });

  it("factory reports a missing key rather than judging with a stand-in", () => {
    const saved = { key: process.env.JEV_API_KEY, typesafe: process.env.TYPESAFE_API_KEY };
    delete process.env.JEV_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      expect(() => getJEVClient({ apiUrl: "", apiKey: "" })).toThrow();
    } finally {
      if (saved.key) process.env.JEV_API_KEY = saved.key;
      if (saved.typesafe) process.env.TYPESAFE_API_KEY = saved.typesafe;
    }
  });
});

describe("Google Fact Check Provider", () => {

  it("factory returns HTTPGoogleFactCheckClient if API key is present", () => {
    const client = getGoogleFactCheckClient({ apiKey: "g-testkey" });
    expect(client).toBeInstanceOf(HTTPGoogleFactCheckClient);
  });

  it("factory never stands in for a missing credential", () => {
    // Without a key the real client reports it cannot look anything up;
    // it never answers with a review nobody published.
    expect(getGoogleFactCheckClient({ apiKey: "" })).toBeInstanceOf(
      HTTPGoogleFactCheckClient
    );
  });

  it("aliases getFactCheckClient to getGoogleFactCheckClient", () => {
    expect(getFactCheckClient).toBe(getGoogleFactCheckClient);
  });
});

describe("Search Provider", () => {

  it("factory returns TavilySearchProvider when API key is provided", () => {
    const provider = getSearchProvider({ apiKey: "tvly-testkey" });
    expect(provider).toBeInstanceOf(TavilySearchProvider);
  });

  it("factory never stands in for a missing credential", () => {
    // The real provider reports the search it could not run.
    expect(getSearchProvider({ apiKey: "" })).toBeInstanceOf(TavilySearchProvider);
  });
});
