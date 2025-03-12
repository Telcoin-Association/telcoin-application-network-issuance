import { LocalFileReferralsRegistry } from "../datasources/ReferralsRegistry";
import UserEntry from "../data/UserEntry";

// Sample user data for testing
const sampleUserData: UserEntry[] = [
  {
    user_id: "user0",
    polygon_wallet_address: "0x0000000000000000000000000000000000000000",
    referral_code: "code0",
    referred_by_user_id: "",
    referred_user_ids: '["user1", "user2"]',
  },
  {
    user_id: "user1",
    polygon_wallet_address: "0x0000000000000000000000000000000000000001",
    referral_code: "code1",
    referred_by_user_id: "user0",
    referred_user_ids: "[null]",
  },
  {
    user_id: "user2",
    polygon_wallet_address: "0x0000000000000000000000000000000000000002",
    referral_code: "code2",
    referred_by_user_id: "user0",
    referred_user_ids: '["user3", "user4"]',
  },
  {
    user_id: "user3",
    polygon_wallet_address: "0x0000000000000000000000000000000000000003",
    referral_code: "code3",
    referred_by_user_id: "user2",
    referred_user_ids: "[null]",
  },
  {
    user_id: "user4",
    polygon_wallet_address: "0x0000000000000000000000000000000000000004",
    referral_code: "code4",
    referred_by_user_id: "user2",
    referred_user_ids: "[null]",
  },
];

describe("LocalFileReferralsRegistry", () => {
  let registry: LocalFileReferralsRegistry;

  beforeEach(() => {
    registry = new LocalFileReferralsRegistry(sampleUserData);
  });

  test("should correctly parse referral data", () => {
    const referrals = registry.referrals;
    expect(referrals.length).toBe(2);

    // only user0 and user2 are referrers
    expect(referrals[0].referrerId).toBe("user0");
    expect(referrals[0].refereeIds).toEqual(["user1", "user2"]);
    expect(referrals[1].referrerId).toBe("user2");
    expect(referrals[1].refereeIds).toEqual(["user3", "user4"]);
  });

  test("should return correct referees for a referrer", () => {
    const refereesUser0 = registry.getRefereesForReferrer("user0");
    expect(refereesUser0.length).toEqual(2);
    expect(refereesUser0).toEqual(["user1", "user2"]);

    const refereesUser2 = registry.getRefereesForReferrer("user2");
    expect(refereesUser2.length).toEqual(2);
    expect(refereesUser2).toEqual(["user3", "user4"]);
  });

  test("should return correct referrer for a referee", () => {
    expect(registry.getReferrerForReferee("user1")).toBe("user0");
    expect(registry.getReferrerForReferee("user2")).toBe("user0");

    expect(registry.getReferrerForReferee("user3")).toBe("user2");
    expect(registry.getReferrerForReferee("user4")).toBe("user2");
  });

  test("should extract referrals covering`referred_by_user` relationships despite extraction via `referred_user_ids`", () => {
    // iterate through inputs to check `referred_by_user`matches referrals extracted via `referred_user_ids`
    for (const userEntry of sampleUserData) {
      const user = userEntry.user_id;
      const referrer = userEntry.referred_by_user_id;
      if (referrer) {
        const referees = registry.getRefereesForReferrer(referrer);
        expect(referees).toContain(user);
      }
    }
  });

  test("should return undefined for a referee that has no referrer", () => {
    expect(registry.getReferrerForReferee("user0")).toBeUndefined();
  });

  test("should handle file with no referred_user_ids", () => {
    const entryWithEmptyReferredIds: UserEntry = {
      user_id: "user42",
      polygon_wallet_address: "0x0000000000000000000000000000000000000042",
      referral_code: "code42",
      referred_by_user_id: "",
      referred_user_ids: "[null]",
    };

    registry = new LocalFileReferralsRegistry([entryWithEmptyReferredIds]);

    // no referrer should be extracted
    const referrals = registry.referrals;
    expect(referrals.length).toBe(0);
  });
});
