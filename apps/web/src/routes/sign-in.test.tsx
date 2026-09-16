import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SignInForm } from "./sign-in.js";

const signIn = vi.fn();

beforeEach(() => { signIn.mockReset(); });

describe("SignInForm", () => {
  it("submits the email and password", async () => {
    signIn.mockResolvedValue({ error: null });
    render(<SignInForm onSignIn={signIn} />);

    await userEvent.type(screen.getByLabelText(/email/i), "me@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "hunter22hunter22");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(signIn).toHaveBeenCalledWith("me@example.com", "hunter22hunter22");
  });

  it("shows the server's message when sign-in fails", async () => {
    signIn.mockResolvedValue({ error: { message: "Invalid email or password" } });
    render(<SignInForm onSignIn={signIn} />);

    await userEvent.type(screen.getByLabelText(/email/i), "me@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "wrong");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
  });

  it("disables the button while the request is in flight", async () => {
    let resolve: (v: unknown) => void = () => {};
    signIn.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<SignInForm onSignIn={signIn} />);

    await userEvent.type(screen.getByLabelText(/email/i), "me@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "hunter22hunter22");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(screen.getByRole("button", { name: /signing in/i })).toBeDisabled();
    resolve({ error: null });
  });
});
