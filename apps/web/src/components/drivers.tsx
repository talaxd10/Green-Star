"use client";

// The drivers' own accounts: the office's money each one holds for the road.

import type { Currency, DriverAccount, ExpenseCategory } from "@green-star/contracts";
import Link from "next/link";
import { Card, CardHead, Empty, Input, Loading, Select, Table, Td, Th } from "@/components/ui";
import { useGet } from "@/lib/hooks";
import { dayTime } from "@/lib/labels";
import { formatMoney } from "@/lib/money";

export const EXPENSE: Record<ExpenseCategory, string> = {
  fuel_car: "Fuel",
  car_parts: "Car parts and repairs",
  workers: "Workers and loading",
  transport: "Transport company between cities",
  driver_pay: "Driver pay",
  customs_airport: "Customs and airport",
  rent_salaries: "Rent and salaries",
  other: "Other",
};

/** What he holds, in words: "485,000 IQD", "we owe him $25.00", "nothing". */
export function holdsText(account: Pick<DriverAccount, "holdsUsdCents" | "holdsIqd">): string {
  const parts: string[] = [];
  for (const [amount, currency] of [
    [account.holdsIqd, "IQD"],
    [account.holdsUsdCents, "USD"],
  ] as const) {
    if (amount > 0) parts.push(formatMoney(amount, currency));
    if (amount < 0) parts.push(`we owe him ${formatMoney(-amount, currency)}`);
  }
  return parts.length === 0 ? "nothing" : parts.join(" · ");
}

export function AmountBox({ id, amount, currency, onAmount, onCurrency, problem }: { id: string; amount: string; currency: Currency; onAmount: (v: string) => void; onCurrency: (c: Currency) => void; problem?: string | undefined }) {
  return (
    <div className="flex gap-2">
      <Input id={id} className="num text-right" inputMode="decimal" placeholder={currency === "USD" ? "0.00" : "0"} value={amount} onChange={(e) => onAmount(e.target.value)} problem={problem} />
      <Select aria-label="Currency" className="w-28" value={currency} onChange={(e) => onCurrency(e.target.value as Currency)}>
        <option value="IQD">Dinars</option>
        <option value="USD">Dollars</option>
      </Select>
    </div>
  );
}

/** Every driver and what he holds. On the trusted customers' tab, where the CEO looks for accounts. */
export function DriverAccountsCard() {
  const accounts = useGet<{ items: DriverAccount[] }>("/v1/driver-accounts");
  const items = (accounts.data?.items ?? []).filter((d) => d.active || d.holdsIqd !== 0 || d.holdsUsdCents !== 0);
  return (
    <Card className="mb-5">
      <CardHead title="Drivers' accounts" hint="The office's money each driver holds for the road: given when he leaves, less his receipts and the change he gave at doors." />
      {accounts.data === undefined ? (
        <Loading />
      ) : items.length === 0 ? (
        <Empty title="No drivers yet">Add one in Settings.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Driver</Th>
              <Th right>Holds</Th>
              <Th>Last moved</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((d) => (
              <tr key={d.driverId} className="group hover:bg-sunken/50">
                <Td>
                  <Link href={`/drivers/${d.driverId}`} className="font-semibold text-ink group-hover:text-green" dir="auto">
                    {d.name}
                  </Link>
                  {!d.active ? <span className="ml-2 text-[12px] text-muted">switched off</span> : null}
                </Td>
                <Td right className={`num ${d.holdsIqd < 0 || d.holdsUsdCents < 0 ? "text-amber-ink" : ""}`}>
                  {holdsText(d)}
                </Td>
                <Td className="text-[13px] text-muted">{d.lastMovedAt ? dayTime(d.lastMovedAt) : "never"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
