// Who may call an address.
//
// The system is the CEO's alone: there is one kind of account, his. So an
// address is either open before signing in (signing in and out, the health
// check) or it needs him signed in. There is nothing in between.

export const ACCESS = ["public", "signed_in"] as const;
export type Access = (typeof ACCESS)[number];
