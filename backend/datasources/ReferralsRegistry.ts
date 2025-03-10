// this class keeps track of referral relationships between users
// provides methods for looking up the referrer of a given user as well as the users that a given user has referred

import { DeepReadonly } from "../helpers";
import UserEntry from "../data/UserEntry";

export type Referral = {
  referrerId: string;
  refereeIds: string[];
};

/**
 * This class represents a registry of referrals.
 *
 * It keeps track of referral relationships between user ID's.
 */
export abstract class BaseReferralsRegistry {
  private _referrals: DeepReadonly<Referral[]> = [];
  private _referrerToReferees: Map<string, string[]> = new Map();
  private _refereeToReferrer: Map<string, string> = new Map();

  get referrals(): DeepReadonly<Referral[]> {
    return this._referrals;
  }

  /**
   * @param referrerId Referrer ID
   * @returns The user ID's of the users that the given referrer has referred
   */
  getRefereesForReferrer(referrerId: string): DeepReadonly<string[]> {
    return this._referrerToReferees.get(referrerId) ?? [];
  }

  /**
   * @param refereeId Referee ID
   * @returns The user ID of the user that referred the given referee
   */
  getReferrerForReferee(refereeId: string): string | undefined {
    return this._refereeToReferrer.get(refereeId)!;
  }

  protected _setReferrals(referrals: DeepReadonly<Referral[]>) {
    // set array
    this._referrals = referrals;
    // set mappings
    this._referrerToReferees = new Map();
    this._refereeToReferrer = new Map();

    for (const referral of referrals) {
      const { referrerId, refereeIds } = referral;
      // set referrer -> referees mapping
      const existingRefereeIds = this._referrerToReferees.get(referrerId) || [];
      this._referrerToReferees.set(referrerId, [
        ...new Set([...existingRefereeIds, ...refereeIds]),
      ]);

      // set referee -> referrer mapping
      for (const refereeId of refereeIds) {
        this._refereeToReferrer.set(refereeId, referrerId);
      }
    }
  }
}

export class LocalFileReferralsRegistry extends BaseReferralsRegistry {
  constructor(userEntriesData: UserEntry[]) {
    super();

    // read referrals from local file
    let referrals: Referral[] = [];
    try {
      referrals = this.extractReferrals(userEntriesData);
    } catch (err) {
      console.error(err);
      throw new Error("Malformed users_wallets_referrals.json input");
    }

    // construct referral graph and set in state
    this._setReferrals(referrals);
  }

  extractReferrals(userEntriesData: UserEntry[]) {
    let referrals: Referral[] = [];
    for (const entry of userEntriesData) {
      const referredIds = JSON.parse(entry.referred_user_ids) as (
        | string
        | null
      )[];

      // TAN backend uses single `null` member for empty `referred_user_ids`
      const filteredReferredUserIds = referredIds.filter((id) => id !== null);
      if (filteredReferredUserIds.length > 0) {
        referrals.push({
          referrerId: entry.user_id,
          refereeIds: filteredReferredUserIds as string[],
        });
      }
    }

    return referrals;
  }
}
