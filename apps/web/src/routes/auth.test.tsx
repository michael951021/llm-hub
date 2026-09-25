import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthForm, type AuthValues } from "./auth.js";

const onSubmit = vi.fn();
beforeEach(() => { onSubmit.mockReset(); });

function renderForm(fields: ("name" | "email" | "password")[] = ["email", "password"]) {
  render(<AuthForm title="Sign in" fields={fields} submitLabel="Sign in" busyLabel="Signing in…" onSubmit={onSubmit} />);
}

async function fillAndSubmit(values: Partial<AuthValues>) {
  for (const [field, value] of Object.entries(values)) {
    await userEvent.type(screen.getByLabelText(new RegExp(field, "i")), value);
  }
  await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

describe("AuthForm", () => {
  it("renders only the requested fields and submits their values", async () => {
    onSubmit.mockResolvedValue({ error: null });
    renderForm(["name", "email", "password"]);
    await fillAndSubmit({ name: "Ada", email: "me@example.com", password: "hunter22hunter22" });
    expect(onSubmit).toHaveBeenCalledWith({ name: "Ada", email: "me@example.com", password: "hunter22hunter22" });
  });

  it("omits fields it was not given", () => {
    renderForm();
    expect(screen.queryByLabelText(/name/i)).toBeNull();
  });

  it("shows the server's message when submission fails", async () => {
    onSubmit.mockResolvedValue({ error: { message: "Invalid email or password" } });
    renderForm();
    await fillAndSubmit({ email: "me@example.com", password: "wrong" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
  });

  it("disables the button while the request is in flight", async () => {
    let resolve: (v: unknown) => void = () => {};
    onSubmit.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderForm();
    await fillAndSubmit({ email: "me@example.com", password: "hunter22hunter22" });
    expect(screen.getByRole("button", { name: /signing in/i })).toBeDisabled();
    resolve({ error: null });
  });
});
