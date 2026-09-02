// ABI of the V3 `SimplePlugin`. Generated from the tel-v3-staking forge artifact.
export default [
  {
    type: "constructor",
    inputs: [
      {
        type: "address",
        name: "_staking",
        internalType: "address"
      },
      {
        type: "address",
        name: "_rewardToken",
        internalType: "address"
      }
    ],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "NATIVE_TOKEN",
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
    name: "_deactivated",
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
    name: "_deactivationDelay",
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
    name: "_deactivationTime",
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
    name: "claim",
    inputs: [
      {
        type: "address",
        name: "account",
        internalType: "address"
      },
      {
        type: "address",
        name: "to",
        internalType: "address"
      },
      {
        type: "bytes",
        name: "",
        internalType: "bytes"
      }
    ],
    outputs: [
      {
        type: "uint256",
        name: "",
        internalType: "uint256"
      }
    ],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "claimable",
    inputs: [
      {
        type: "address",
        name: "account",
        internalType: "address"
      },
      {
        type: "bytes",
        name: "",
        internalType: "bytes"
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
    name: "claimableAt",
    inputs: [
      {
        type: "address",
        name: "account",
        internalType: "address"
      },
      {
        type: "uint256",
        name: "blockNumber",
        internalType: "uint256"
      },
      {
        type: "bytes",
        name: "",
        internalType: "bytes"
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
    name: "cleanupPostDeactivation",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable"
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
    name: "increaseClaimableBy",
    inputs: [
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
    ],
    outputs: [
      {
        type: "bool",
        name: "",
        internalType: "bool"
      }
    ],
    stateMutability: "payable"
  },
  {
    type: "function",
    name: "increaseClaimableByBatch",
    inputs: [
      {
        type: "address[]",
        name: "accounts",
        internalType: "address[]"
      },
      {
        type: "uint256[]",
        name: "amounts",
        internalType: "uint256[]"
      },
      {
        type: "uint256",
        name: "totalAmount",
        internalType: "uint256"
      }
    ],
    outputs: [
      {
        type: "bool",
        name: "",
        internalType: "bool"
      }
    ],
    stateMutability: "payable"
  },
  {
    type: "function",
    name: "increaser",
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
    name: "isNative",
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
    name: "pause",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "paused",
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
        internalType: "address"
      },
      {
        type: "uint256",
        name: "amount",
        internalType: "uint256"
      },
      {
        type: "address",
        name: "to",
        internalType: "address"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "rewardToken",
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
    name: "rewardToken_",
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
    name: "setIncreaser",
    inputs: [
      {
        type: "address",
        name: "newIncreaser",
        internalType: "address"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "staking",
    inputs: [],
    outputs: [
      {
        type: "address",
        name: "",
        internalType: "contract IStakingModule"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "startDeactivation",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "supportsInterface",
    inputs: [
      {
        type: "bytes4",
        name: "interfaceId",
        internalType: "bytes4"
      }
    ],
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
    name: "totalClaimable",
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
    type: "function",
    name: "unpause",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable"
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
        name: "amount",
        indexed: false,
        internalType: "uint256"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      {
        type: "address",
        name: "account",
        indexed: true,
        internalType: "address"
      },
      {
        type: "address",
        name: "to",
        indexed: true,
        internalType: "address"
      },
      {
        type: "uint256",
        name: "amount",
        indexed: false,
        internalType: "uint256"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "DeactivationInitiated",
    inputs: [
      {
        type: "uint256",
        name: "deactivationTime",
        indexed: false,
        internalType: "uint256"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "IncreaserChanged",
    inputs: [
      {
        type: "address",
        name: "oldIncreaser",
        indexed: true,
        internalType: "address"
      },
      {
        type: "address",
        name: "newIncreaser",
        indexed: true,
        internalType: "address"
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
    type: "event",
    name: "Paused",
    inputs: [
      {
        type: "address",
        name: "account",
        indexed: false,
        internalType: "address"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "Unpaused",
    inputs: [
      {
        type: "address",
        name: "account",
        indexed: false,
        internalType: "address"
      }
    ],
    anonymous: false
  },
  {
    type: "error",
    name: "AddressEmptyCode",
    inputs: [
      {
        type: "address",
        name: "target",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "AddressInsufficientBalance",
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
    name: "BatchLengthMismatch",
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
    name: "BatchTotalMismatch",
    inputs: [
      {
        type: "uint256",
        name: "declaredTotal",
        internalType: "uint256"
      },
      {
        type: "uint256",
        name: "summedAmounts",
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
    name: "CheckpointValueExceedsMax",
    inputs: [
      {
        type: "uint256",
        name: "value",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "Deactivated",
    inputs: []
  },
  {
    type: "error",
    name: "EmptyBatch",
    inputs: []
  },
  {
    type: "error",
    name: "EnforcedPause",
    inputs: []
  },
  {
    type: "error",
    name: "ExpectedPause",
    inputs: []
  },
  {
    type: "error",
    name: "FailedInnerCall",
    inputs: []
  },
  {
    type: "error",
    name: "FutureBlockNumber",
    inputs: [
      {
        type: "uint256",
        name: "blockNumber",
        internalType: "uint256"
      },
      {
        type: "uint256",
        name: "currentBlock",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "MsgValueMismatch",
    inputs: [
      {
        type: "uint256",
        name: "expected",
        internalType: "uint256"
      },
      {
        type: "uint256",
        name: "actual",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "NativeTransferFailed",
    inputs: []
  },
  {
    type: "error",
    name: "NotIncreaser",
    inputs: [
      {
        type: "address",
        name: "caller",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "OnlyStaking",
    inputs: [
      {
        type: "address",
        name: "caller",
        internalType: "address"
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
    name: "ReentrancyGuardReentrantCall",
    inputs: []
  },
  {
    type: "error",
    name: "RescueExceedsFree",
    inputs: [
      {
        type: "uint256",
        name: "requested",
        internalType: "uint256"
      },
      {
        type: "uint256",
        name: "free",
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
    name: "UnexpectedMsgValue",
    inputs: []
  },
  {
    type: "error",
    name: "ZeroAddress",
    inputs: []
  }
] as const;
