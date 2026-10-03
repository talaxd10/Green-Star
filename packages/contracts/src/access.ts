// Who can do what. The roles table from the board, as data.
//
// "I see everything. The owner sees everything. Everyone else doesn't see
// anything except what we decide to show them in the monitor."

export const ROLES = ["ceo", "owner", "monitor"] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  "see_books", // balances, ledger, reports, every screen
  "import_files", // import files and confirm their charges
  "enter_money", // rounds, payments, cash outs, the rate, vault close
  "allow_exception", // let a pay-first customer take goods without paying in full
  "change_trust", // trust and limit, on the China office's word
  "reverse", // reverse a mistake
  "manage_users", // users and settings
  "see_monitor", // the office screen's widgets
] as const;
export type Action = (typeof ACTIONS)[number];

export const CAN: Readonly<Record<Role, readonly Action[]>> = {
  ceo: ACTIONS,
  owner: ["see_books"],
  monitor: ["see_monitor"],
};

export function can(role: Role, action: Action): boolean {
  return CAN[role].includes(action);
}

/** Who may call an address: anyone, or these roles. */
export type Access = "public" | readonly Role[];

export const EVERYONE: readonly Role[] = ROLES;
/** The CEO and the owner: everyone who sees the books. */
export const READERS: readonly Role[] = ["ceo", "owner"];
export const CEO_ONLY: readonly Role[] = ["ceo"];
