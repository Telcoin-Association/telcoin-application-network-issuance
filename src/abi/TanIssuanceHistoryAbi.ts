export default [
  {
    type: "constructor",
    inputs: [
      {
        name: "tanIssuancePlugin_",
        type: "address",
        internalType: "contract ISimplePlugin",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "CLOCK_MODE",
    inputs: [],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "clock",
    inputs: [],
    outputs: [{ name: "", type: "uint48", internalType: "uint48" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "cumulativeRewards",
    inputs: [{ name: "account", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "cumulativeRewardsAtBlock",
    inputs: [
      { name: "account", type: "address", internalType: "address" },
      { name: "queryBlock", type: "uint256", internalType: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "cumulativeRewardsAtBlockBatched",
    inputs: [
      { name: "accounts", type: "address[]", internalType: "address[]" },
      { name: "queryBlock", type: "uint256", internalType: "uint256" },
    ],
    outputs: [
      { name: "", type: "address[]", internalType: "address[]" },
      { name: "", type: "uint256[]", internalType: "uint256[]" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "deactivated",
    inputs: [],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "increaseClaimableByBatch",
    inputs: [
      { name: "accounts", type: "address[]", internalType: "address[]" },
      { name: "amounts", type: "uint256[]", internalType: "uint256[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "lastSettlementBlock",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "renounceOwnership",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "rescueTokens",
    inputs: [
      { name: "token", type: "address", internalType: "contract IERC20" },
      { name: "to", type: "address", internalType: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "tanIssuancePlugin",
    inputs: [],
    outputs: [
      { name: "", type: "address", internalType: "contract ISimplePlugin" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "transferOwnership",
    inputs: [{ name: "newOwner", type: "address", internalType: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "ClaimableIncreased",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "oldClaimable",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "newClaimable",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OwnershipTransferred",
    inputs: [
      {
        name: "previousOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "newOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "AddressEmptyCode",
    inputs: [{ name: "target", type: "address", internalType: "address" }],
  },
  {
    type: "error",
    name: "AddressInsufficientBalance",
    inputs: [{ name: "account", type: "address", internalType: "address" }],
  },
  { type: "error", name: "ArityMismatch", inputs: [] },
  { type: "error", name: "CheckpointUnorderedInsertion", inputs: [] },
  { type: "error", name: "Deactivated", inputs: [] },
  { type: "error", name: "ERC6372InconsistentClock", inputs: [] },
  { type: "error", name: "FailedInnerCall", inputs: [] },
  {
    type: "error",
    name: "FutureLookup",
    inputs: [
      { name: "queriedBlock", type: "uint256", internalType: "uint256" },
      { name: "clockBlock", type: "uint48", internalType: "uint48" },
    ],
  },
  {
    type: "error",
    name: "OwnableInvalidOwner",
    inputs: [{ name: "owner", type: "address", internalType: "address" }],
  },
  {
    type: "error",
    name: "OwnableUnauthorizedAccount",
    inputs: [{ name: "account", type: "address", internalType: "address" }],
  },
  {
    type: "error",
    name: "SafeCastOverflowedUintDowncast",
    inputs: [
      { name: "bits", type: "uint8", internalType: "uint8" },
      { name: "value", type: "uint256", internalType: "uint256" },
    ],
  },
  {
    type: "error",
    name: "SafeERC20FailedOperation",
    inputs: [{ name: "token", type: "address", internalType: "address" }],
  },
] as const;
