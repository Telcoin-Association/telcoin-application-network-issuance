// ABI of `TANIssuanceHistory`. Generated from this repo's forge artifact via `forge build`.
export default [
  {
    type: "constructor",
    inputs: [
      {
        type: "address",
        name: "tanIssuancePlugin_",
        internalType: "contract ISimplePlugin"
      },
      {
        type: "address",
        name: "owner_",
        internalType: "address"
      }
    ],
    stateMutability: "nonpayable"
  },
  {
    type: "receive",
    stateMutability: "payable"
  },
  {
    type: "function",
    name: "CLOCK_MODE",
    inputs: [],
    outputs: [
      {
        type: "string",
        name: "",
        internalType: "string"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "backfillCumulativeRewards",
    inputs: [
      {
        type: "address[]",
        name: "accounts",
        internalType: "address[]"
      },
      {
        type: "uint256[]",
        name: "cumulativeAmounts",
        internalType: "uint256[]"
      },
      {
        type: "uint256",
        name: "atBlock",
        internalType: "uint256"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "backfillSealed",
    inputs: [],
    outputs: [
      {
        type: "bool",
        name: "",
        internalType: "bool"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "clock",
    inputs: [],
    outputs: [
      {
        type: "uint48",
        name: "",
        internalType: "uint48"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "cumulativeRewards",
    inputs: [
      {
        type: "address",
        name: "account",
        internalType: "address"
      }
    ],
    outputs: [
      {
        type: "uint256",
        name: "",
        internalType: "uint256"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "cumulativeRewardsAtBlock",
    inputs: [
      {
        type: "address",
        name: "account",
        internalType: "address"
      },
      {
        type: "uint256",
        name: "queryBlock",
        internalType: "uint256"
      }
    ],
    outputs: [
      {
        type: "uint256",
        name: "",
        internalType: "uint256"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "cumulativeRewardsAtBlockBatched",
    inputs: [
      {
        type: "address[]",
        name: "accounts",
        internalType: "address[]"
      },
      {
        type: "uint256",
        name: "queryBlock",
        internalType: "uint256"
      }
    ],
    outputs: [
      {
        type: "address[]",
        name: "",
        internalType: "address[]"
      },
      {
        type: "uint256[]",
        name: "",
        internalType: "uint256[]"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "deactivated",
    inputs: [],
    outputs: [
      {
        type: "bool",
        name: "",
        internalType: "bool"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "increaseClaimableByBatch",
    inputs: [
      {
        type: "tuple[]",
        name: "rewards",
        internalType: "struct TANIssuanceHistory.IssuanceReward[]",
        components: [
          {
            type: "address",
            name: "account",
            internalType: "address"
          },
          {
            type: "uint256",
            name: "amount",
            internalType: "uint256"
          }
        ]
      },
      {
        type: "uint256",
        name: "endBlock",
        internalType: "uint256"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "lastSettlementBlock",
    inputs: [],
    outputs: [
      {
        type: "uint256",
        name: "",
        internalType: "uint256"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [
      {
        type: "address",
        name: "",
        internalType: "address"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "renounceOwnership",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "rescueTokens",
    inputs: [
      {
        type: "address",
        name: "token",
        internalType: "contract IERC20"
      },
      {
        type: "address",
        name: "recipient",
        internalType: "address"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "sealBackfill",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "setTanIssuancePlugin",
    inputs: [
      {
        type: "address",
        name: "newPlugin",
        internalType: "contract ISimplePlugin"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "tanIssuancePlugin",
    inputs: [],
    outputs: [
      {
        type: "address",
        name: "",
        internalType: "contract ISimplePlugin"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "tel",
    inputs: [],
    outputs: [
      {
        type: "address",
        name: "",
        internalType: "address"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "telIsNative",
    inputs: [],
    outputs: [
      {
        type: "bool",
        name: "",
        internalType: "bool"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "transferOwnership",
    inputs: [
      {
        type: "address",
        name: "newOwner",
        internalType: "address"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "event",
    name: "BackfillSealed",
    inputs: [],
    anonymous: false
  },
  {
    type: "event",
    name: "ClaimableIncreased",
    inputs: [
      {
        type: "address",
        name: "account",
        indexed: true,
        internalType: "address"
      },
      {
        type: "uint256",
        name: "oldClaimable",
        indexed: false,
        internalType: "uint256"
      },
      {
        type: "uint256",
        name: "newClaimable",
        indexed: false,
        internalType: "uint256"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "CumulativeRewardsBackfilled",
    inputs: [
      {
        type: "address",
        name: "account",
        indexed: true,
        internalType: "address"
      },
      {
        type: "uint256",
        name: "amount",
        indexed: false,
        internalType: "uint256"
      },
      {
        type: "uint256",
        name: "atBlock",
        indexed: false,
        internalType: "uint256"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "OwnershipTransferred",
    inputs: [
      {
        type: "address",
        name: "previousOwner",
        indexed: true,
        internalType: "address"
      },
      {
        type: "address",
        name: "newOwner",
        indexed: true,
        internalType: "address"
      }
    ],
    anonymous: false
  },
  {
    type: "error",
    name: "BackfillIsSealed",
    inputs: []
  },
  {
    type: "error",
    name: "BackfillLengthMismatch",
    inputs: [
      {
        type: "uint256",
        name: "accountsLength",
        internalType: "uint256"
      },
      {
        type: "uint256",
        name: "amountsLength",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "CheckpointUnorderedInsertion",
    inputs: []
  },
  {
    type: "error",
    name: "ERC6372InconsistentClock",
    inputs: []
  },
  {
    type: "error",
    name: "FutureLookup",
    inputs: [
      {
        type: "uint256",
        name: "queriedBlock",
        internalType: "uint256"
      },
      {
        type: "uint48",
        name: "clockBlock",
        internalType: "uint48"
      }
    ]
  },
  {
    type: "error",
    name: "IncompatiblePlugin",
    inputs: []
  },
  {
    type: "error",
    name: "IncreaseClaimableByBatchFailed",
    inputs: []
  },
  {
    type: "error",
    name: "InvalidAddress",
    inputs: [
      {
        type: "address",
        name: "invalidAddress",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "InvalidBlock",
    inputs: [
      {
        type: "uint256",
        name: "endBlock",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "OwnableInvalidOwner",
    inputs: [
      {
        type: "address",
        name: "owner",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "OwnableUnauthorizedAccount",
    inputs: [
      {
        type: "address",
        name: "account",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "SafeCastOverflowedUintDowncast",
    inputs: [
      {
        type: "uint8",
        name: "bits",
        internalType: "uint8"
      },
      {
        type: "uint256",
        name: "value",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "SafeERC20FailedOperation",
    inputs: [
      {
        type: "address",
        name: "token",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "UnexpectedNative",
    inputs: []
  }
] as const;
