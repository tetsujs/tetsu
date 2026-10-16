/**
 * The generated contract and `ContractOf<typeof app>` are one type: the
 * contract in `test-utils` was printed from the application beside it,
 * and a test of the generator checks that it still is.
 *
 * @module
 */

import type { Equal, Expect } from "../../core/test-utils/types.ts";
import type { Api } from "../test-utils/contract-app.contract.js";
import type { app } from "../test-utils/contract-app.ts";
import type { ContractOf } from "./index.ts";

type Direct = ContractOf<typeof app>;

type Each = {
  [K in keyof Direct]: K extends keyof Api ? Equal<Api[K], Direct[K]> : false;
};

export type Tests = [
  Expect<Equal<Api, Direct>>,
  Expect<Equal<Each[keyof Each], true>>,
  Expect<Equal<keyof Api, keyof Direct>>,
];
