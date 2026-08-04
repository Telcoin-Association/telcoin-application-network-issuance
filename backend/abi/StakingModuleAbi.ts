// ABI of the V3 `StakingModule` (sTEL). Generated from the tel-v3-staking forge artifact.
export default [
  {
    type: "constructor",
    inputs: [
      {
        type: "address",
        name: "tel_",
        internalType: "contract IERC20"
      },
      {
        type: "uint256",
        name: "maxWithdrawalDelay_",
        internalType: "uint256"
      }
    ],
    stateMutability: "nonpayable"
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
    name: "DEFAULT_ADMIN_ROLE",
    inputs: [],
    outputs: [
      {
        type: "bytes32",
        name: "",
        internalType: "bytes32"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    inputs: [],
    outputs: [
      {
        type: "bytes32",
        name: "",
        internalType: "bytes32"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "MAX_DELAY_INCREASE_PER_DAY",
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
    name: "MAX_PENDING_WITHDRAWALS_PER_USER",
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
    name: "MAX_TIMING_BOUND",
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
    name: "MIGRATOR_ROLE",
    inputs: [],
    outputs: [
      {
        type: "bytes32",
        name: "",
        internalType: "bytes32"
      }
    ],
    stateMutability: "view"
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
    name: "PARAM_SETTER_ROLE",
    inputs: [],
    outputs: [
      {
        type: "bytes32",
        name: "",
        internalType: "bytes32"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "PAUSER_ROLE",
    inputs: [],
    outputs: [
      {
        type: "bytes32",
        name: "",
        internalType: "bytes32"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "PLUGIN_EDITOR_ROLE",
    inputs: [],
    outputs: [
      {
        type: "bytes32",
        name: "",
        internalType: "bytes32"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "RECOVERY_ROLE",
    inputs: [],
    outputs: [
      {
        type: "bytes32",
        name: "",
        internalType: "bytes32"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "UPGRADER_ROLE",
    inputs: [],
    outputs: [
      {
        type: "bytes32",
        name: "",
        internalType: "bytes32"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "UPGRADE_INTERFACE_VERSION",
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
    name: "addPlugin",
    inputs: [
      {
        type: "address",
        name: "plugin",
        internalType: "address"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "adminRemovePlugin",
    inputs: [
      {
        type: "address",
        name: "plugin",
        internalType: "address"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      {
        type: "address",
        name: "owner",
        internalType: "address"
      },
      {
        type: "address",
        name: "spender",
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
    name: "approve",
    inputs: [
      {
        type: "address",
        name: "spender",
        internalType: "address"
      },
      {
        type: "uint256",
        name: "value",
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
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "balanceOf",
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
    name: "cancelWithdrawal",
    inputs: [
      {
        type: "uint256",
        name: "withdrawalId",
        internalType: "uint256"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "checkpoints",
    inputs: [
      {
        type: "address",
        name: "account",
        internalType: "address"
      },
      {
        type: "uint32",
        name: "pos",
        internalType: "uint32"
      }
    ],
    outputs: [
      {
        type: "tuple",
        name: "",
        internalType: "struct Checkpoints.Checkpoint208",
        components: [
          {
            type: "uint48",
            name: "_key",
            internalType: "uint48"
          },
          {
            type: "uint208",
            name: "_value",
            internalType: "uint208"
          }
        ]
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "claimFromIndividualPlugin",
    inputs: [
      {
        type: "address",
        name: "plugin",
        internalType: "address"
      },
      {
        type: "bytes",
        name: "auxData",
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
    name: "claimFromMany",
    inputs: [
      {
        type: "address[]",
        name: "pluginList",
        internalType: "address[]"
      },
      {
        type: "bytes[]",
        name: "auxData",
        internalType: "bytes[]"
      }
    ],
    outputs: [
      {
        type: "uint256[]",
        name: "claimed",
        internalType: "uint256[]"
      }
    ],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "claimableAtFrom",
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
        type: "address[]",
        name: "pluginList",
        internalType: "address[]"
      },
      {
        type: "bytes[]",
        name: "auxData",
        internalType: "bytes[]"
      }
    ],
    outputs: [
      {
        type: "uint256[]",
        name: "amounts",
        internalType: "uint256[]"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "claimableFrom",
    inputs: [
      {
        type: "address",
        name: "account",
        internalType: "address"
      },
      {
        type: "address[]",
        name: "pluginList",
        internalType: "address[]"
      },
      {
        type: "bytes[]",
        name: "auxData",
        internalType: "bytes[]"
      }
    ],
    outputs: [
      {
        type: "uint256[]",
        name: "amounts",
        internalType: "uint256[]"
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
    name: "decimals",
    inputs: [],
    outputs: [
      {
        type: "uint8",
        name: "",
        internalType: "uint8"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "delegate",
    inputs: [
      {
        type: "address",
        name: "delegatee",
        internalType: "address"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "delegateBySig",
    inputs: [
      {
        type: "address",
        name: "delegatee",
        internalType: "address"
      },
      {
        type: "uint256",
        name: "nonce",
        internalType: "uint256"
      },
      {
        type: "uint256",
        name: "expiry",
        internalType: "uint256"
      },
      {
        type: "uint8",
        name: "v",
        internalType: "uint8"
      },
      {
        type: "bytes32",
        name: "r",
        internalType: "bytes32"
      },
      {
        type: "bytes32",
        name: "s",
        internalType: "bytes32"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "delegates",
    inputs: [
      {
        type: "address",
        name: "account",
        internalType: "address"
      }
    ],
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
    name: "eip712Domain",
    inputs: [],
    outputs: [
      {
        type: "bytes1",
        name: "fields",
        internalType: "bytes1"
      },
      {
        type: "string",
        name: "name",
        internalType: "string"
      },
      {
        type: "string",
        name: "version",
        internalType: "string"
      },
      {
        type: "uint256",
        name: "chainId",
        internalType: "uint256"
      },
      {
        type: "address",
        name: "verifyingContract",
        internalType: "address"
      },
      {
        type: "bytes32",
        name: "salt",
        internalType: "bytes32"
      },
      {
        type: "uint256[]",
        name: "extensions",
        internalType: "uint256[]"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "exit",
    inputs: [
      {
        type: "uint256",
        name: "withdrawalId",
        internalType: "uint256"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "getPastTotalSupply",
    inputs: [
      {
        type: "uint256",
        name: "timepoint",
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
    name: "getPastVotes",
    inputs: [
      {
        type: "address",
        name: "account",
        internalType: "address"
      },
      {
        type: "uint256",
        name: "timepoint",
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
    name: "getRoleAdmin",
    inputs: [
      {
        type: "bytes32",
        name: "role",
        internalType: "bytes32"
      }
    ],
    outputs: [
      {
        type: "bytes32",
        name: "",
        internalType: "bytes32"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "getVotes",
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
    name: "getWithdrawal",
    inputs: [
      {
        type: "uint256",
        name: "id",
        internalType: "uint256"
      }
    ],
    outputs: [
      {
        type: "tuple",
        name: "",
        internalType: "struct IStakingModule.Withdrawal",
        components: [
          {
            type: "address",
            name: "owner",
            internalType: "address"
          },
          {
            type: "uint128",
            name: "amount",
            internalType: "uint128"
          },
          {
            type: "uint64",
            name: "unlockTime",
            internalType: "uint64"
          }
        ]
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "grantRole",
    inputs: [
      {
        type: "bytes32",
        name: "role",
        internalType: "bytes32"
      },
      {
        type: "address",
        name: "account",
        internalType: "address"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "hasRole",
    inputs: [
      {
        type: "bytes32",
        name: "role",
        internalType: "bytes32"
      },
      {
        type: "address",
        name: "account",
        internalType: "address"
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
    name: "initialize",
    inputs: [
      {
        type: "uint256",
        name: "initialWithdrawalDelay_",
        internalType: "uint256"
      },
      {
        type: "uint256",
        name: "migrationDuration_",
        internalType: "uint256"
      },
      {
        type: "address",
        name: "initialAdmin_",
        internalType: "address"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "isPlugin",
    inputs: [
      {
        type: "address",
        name: "p",
        internalType: "address"
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
    name: "maxWithdrawalDelay",
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
    name: "migrationDeadline",
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
    name: "name",
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
    name: "nonces",
    inputs: [
      {
        type: "address",
        name: "owner",
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
    name: "numCheckpoints",
    inputs: [
      {
        type: "address",
        name: "account",
        internalType: "address"
      }
    ],
    outputs: [
      {
        type: "uint32",
        name: "",
        internalType: "uint32"
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
    name: "pendingWithdrawalCount",
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
    name: "pendingWithdrawalIds",
    inputs: [
      {
        type: "address",
        name: "account",
        internalType: "address"
      }
    ],
    outputs: [
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
    name: "permit",
    inputs: [
      {
        type: "address",
        name: "owner",
        internalType: "address"
      },
      {
        type: "address",
        name: "spender",
        internalType: "address"
      },
      {
        type: "uint256",
        name: "value",
        internalType: "uint256"
      },
      {
        type: "uint256",
        name: "deadline",
        internalType: "uint256"
      },
      {
        type: "uint8",
        name: "v",
        internalType: "uint8"
      },
      {
        type: "bytes32",
        name: "r",
        internalType: "bytes32"
      },
      {
        type: "bytes32",
        name: "s",
        internalType: "bytes32"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "pluginCount",
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
    name: "plugins",
    inputs: [
      {
        type: "uint256",
        name: "offset",
        internalType: "uint256"
      },
      {
        type: "uint256",
        name: "limit",
        internalType: "uint256"
      }
    ],
    outputs: [
      {
        type: "address[]",
        name: "",
        internalType: "address[]"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "proxiableUUID",
    inputs: [],
    outputs: [
      {
        type: "bytes32",
        name: "",
        internalType: "bytes32"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "removePlugin",
    inputs: [
      {
        type: "address",
        name: "plugin",
        internalType: "address"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "renounceRole",
    inputs: [
      {
        type: "bytes32",
        name: "role",
        internalType: "bytes32"
      },
      {
        type: "address",
        name: "callerConfirmation",
        internalType: "address"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "requestWithdrawal",
    inputs: [
      {
        type: "uint256",
        name: "amount",
        internalType: "uint256"
      }
    ],
    outputs: [
      {
        type: "uint256",
        name: "withdrawalId",
        internalType: "uint256"
      }
    ],
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
    name: "revokeRole",
    inputs: [
      {
        type: "bytes32",
        name: "role",
        internalType: "bytes32"
      },
      {
        type: "address",
        name: "account",
        internalType: "address"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "setWithdrawalDelay",
    inputs: [
      {
        type: "uint256",
        name: "newDelay",
        internalType: "uint256"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "stake",
    inputs: [
      {
        type: "uint256",
        name: "amount",
        internalType: "uint256"
      }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "stakeFor",
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
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "stakeForBatch",
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
      }
    ],
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
    name: "symbol",
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
    name: "totalPendingWithdrawal",
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
    name: "totalSupply",
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
    name: "transfer",
    inputs: [
      {
        type: "address",
        name: "to",
        internalType: "address"
      },
      {
        type: "uint256",
        name: "value",
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
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "transferFrom",
    inputs: [
      {
        type: "address",
        name: "from",
        internalType: "address"
      },
      {
        type: "address",
        name: "to",
        internalType: "address"
      },
      {
        type: "uint256",
        name: "value",
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
    type: "function",
    name: "upgradeToAndCall",
    inputs: [
      {
        type: "address",
        name: "newImplementation",
        internalType: "address"
      },
      {
        type: "bytes",
        name: "data",
        internalType: "bytes"
      }
    ],
    outputs: [],
    stateMutability: "payable"
  },
  {
    type: "function",
    name: "withdrawalDelay",
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
    type: "event",
    name: "Approval",
    inputs: [
      {
        type: "address",
        name: "owner",
        indexed: true,
        internalType: "address"
      },
      {
        type: "address",
        name: "spender",
        indexed: true,
        internalType: "address"
      },
      {
        type: "uint256",
        name: "value",
        indexed: false,
        internalType: "uint256"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "DelegateChanged",
    inputs: [
      {
        type: "address",
        name: "delegator",
        indexed: true,
        internalType: "address"
      },
      {
        type: "address",
        name: "fromDelegate",
        indexed: true,
        internalType: "address"
      },
      {
        type: "address",
        name: "toDelegate",
        indexed: true,
        internalType: "address"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "DelegateVotesChanged",
    inputs: [
      {
        type: "address",
        name: "delegate",
        indexed: true,
        internalType: "address"
      },
      {
        type: "uint256",
        name: "previousVotes",
        indexed: false,
        internalType: "uint256"
      },
      {
        type: "uint256",
        name: "newVotes",
        indexed: false,
        internalType: "uint256"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "EIP712DomainChanged",
    inputs: [],
    anonymous: false
  },
  {
    type: "event",
    name: "Exited",
    inputs: [
      {
        type: "address",
        name: "account",
        indexed: true,
        internalType: "address"
      },
      {
        type: "uint256",
        name: "withdrawalId",
        indexed: true,
        internalType: "uint256"
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
    name: "Initialized",
    inputs: [
      {
        type: "uint64",
        name: "version",
        indexed: false,
        internalType: "uint64"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "InstantWithdrawal",
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
    name: "PluginAdded",
    inputs: [
      {
        type: "address",
        name: "plugin",
        indexed: true,
        internalType: "address"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "PluginRemoved",
    inputs: [
      {
        type: "address",
        name: "plugin",
        indexed: true,
        internalType: "address"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "Rescued",
    inputs: [
      {
        type: "address",
        name: "token",
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
        type: "address",
        name: "to",
        indexed: true,
        internalType: "address"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "RoleAdminChanged",
    inputs: [
      {
        type: "bytes32",
        name: "role",
        indexed: true,
        internalType: "bytes32"
      },
      {
        type: "bytes32",
        name: "previousAdminRole",
        indexed: true,
        internalType: "bytes32"
      },
      {
        type: "bytes32",
        name: "newAdminRole",
        indexed: true,
        internalType: "bytes32"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "RoleGranted",
    inputs: [
      {
        type: "bytes32",
        name: "role",
        indexed: true,
        internalType: "bytes32"
      },
      {
        type: "address",
        name: "account",
        indexed: true,
        internalType: "address"
      },
      {
        type: "address",
        name: "sender",
        indexed: true,
        internalType: "address"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "RoleRevoked",
    inputs: [
      {
        type: "bytes32",
        name: "role",
        indexed: true,
        internalType: "bytes32"
      },
      {
        type: "address",
        name: "account",
        indexed: true,
        internalType: "address"
      },
      {
        type: "address",
        name: "sender",
        indexed: true,
        internalType: "address"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "Staked",
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
    name: "Transfer",
    inputs: [
      {
        type: "address",
        name: "from",
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
        name: "value",
        indexed: false,
        internalType: "uint256"
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
    type: "event",
    name: "Upgraded",
    inputs: [
      {
        type: "address",
        name: "implementation",
        indexed: true,
        internalType: "address"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "WithdrawalCancelled",
    inputs: [
      {
        type: "address",
        name: "account",
        indexed: true,
        internalType: "address"
      },
      {
        type: "uint256",
        name: "withdrawalId",
        indexed: true,
        internalType: "uint256"
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
    name: "WithdrawalDelaySet",
    inputs: [
      {
        type: "uint256",
        name: "oldDelay",
        indexed: false,
        internalType: "uint256"
      },
      {
        type: "uint256",
        name: "newDelay",
        indexed: false,
        internalType: "uint256"
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "WithdrawalRequested",
    inputs: [
      {
        type: "address",
        name: "account",
        indexed: true,
        internalType: "address"
      },
      {
        type: "uint256",
        name: "withdrawalId",
        indexed: true,
        internalType: "uint256"
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
    type: "error",
    name: "AccessControlBadConfirmation",
    inputs: []
  },
  {
    type: "error",
    name: "AccessControlUnauthorizedAccount",
    inputs: [
      {
        type: "address",
        name: "account",
        internalType: "address"
      },
      {
        type: "bytes32",
        name: "neededRole",
        internalType: "bytes32"
      }
    ]
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
    name: "CheckpointUnorderedInsertion",
    inputs: []
  },
  {
    type: "error",
    name: "DelayExceedsMax",
    inputs: [
      {
        type: "uint256",
        name: "requested",
        internalType: "uint256"
      },
      {
        type: "uint256",
        name: "max",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "DelayIncreaseTooFast",
    inputs: [
      {
        type: "uint256",
        name: "requested",
        internalType: "uint256"
      },
      {
        type: "uint256",
        name: "maxAllowed",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "ECDSAInvalidSignature",
    inputs: []
  },
  {
    type: "error",
    name: "ECDSAInvalidSignatureLength",
    inputs: [
      {
        type: "uint256",
        name: "length",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "ECDSAInvalidSignatureS",
    inputs: [
      {
        type: "bytes32",
        name: "s",
        internalType: "bytes32"
      }
    ]
  },
  {
    type: "error",
    name: "ERC1967InvalidImplementation",
    inputs: [
      {
        type: "address",
        name: "implementation",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "ERC1967NonPayable",
    inputs: []
  },
  {
    type: "error",
    name: "ERC20ExceededSafeSupply",
    inputs: [
      {
        type: "uint256",
        name: "increasedSupply",
        internalType: "uint256"
      },
      {
        type: "uint256",
        name: "cap",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "ERC20InsufficientAllowance",
    inputs: [
      {
        type: "address",
        name: "spender",
        internalType: "address"
      },
      {
        type: "uint256",
        name: "allowance",
        internalType: "uint256"
      },
      {
        type: "uint256",
        name: "needed",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "ERC20InsufficientBalance",
    inputs: [
      {
        type: "address",
        name: "sender",
        internalType: "address"
      },
      {
        type: "uint256",
        name: "balance",
        internalType: "uint256"
      },
      {
        type: "uint256",
        name: "needed",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "ERC20InvalidApprover",
    inputs: [
      {
        type: "address",
        name: "approver",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "ERC20InvalidReceiver",
    inputs: [
      {
        type: "address",
        name: "receiver",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "ERC20InvalidSender",
    inputs: [
      {
        type: "address",
        name: "sender",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "ERC20InvalidSpender",
    inputs: [
      {
        type: "address",
        name: "spender",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "ERC2612ExpiredSignature",
    inputs: [
      {
        type: "uint256",
        name: "deadline",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "ERC2612InvalidSigner",
    inputs: [
      {
        type: "address",
        name: "signer",
        internalType: "address"
      },
      {
        type: "address",
        name: "owner",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "ERC5805FutureLookup",
    inputs: [
      {
        type: "uint256",
        name: "timepoint",
        internalType: "uint256"
      },
      {
        type: "uint48",
        name: "clock",
        internalType: "uint48"
      }
    ]
  },
  {
    type: "error",
    name: "ERC6372InconsistentClock",
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
    name: "InsufficientSTel",
    inputs: [
      {
        type: "uint256",
        name: "requested",
        internalType: "uint256"
      },
      {
        type: "uint256",
        name: "available",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "InvalidAccountNonce",
    inputs: [
      {
        type: "address",
        name: "account",
        internalType: "address"
      },
      {
        type: "uint256",
        name: "currentNonce",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "InvalidInitialization",
    inputs: []
  },
  {
    type: "error",
    name: "LengthMismatch",
    inputs: []
  },
  {
    type: "error",
    name: "MigrationEnded",
    inputs: [
      {
        type: "uint256",
        name: "deadline",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "NotInitializing",
    inputs: []
  },
  {
    type: "error",
    name: "NotWithdrawalOwner",
    inputs: [
      {
        type: "address",
        name: "caller",
        internalType: "address"
      },
      {
        type: "address",
        name: "owner",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "PluginAlreadyDeactivated",
    inputs: [
      {
        type: "address",
        name: "plugin",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "PluginAlreadyRegistered",
    inputs: [
      {
        type: "address",
        name: "plugin",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "PluginMisreported",
    inputs: [
      {
        type: "address",
        name: "plugin",
        internalType: "address"
      },
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
    name: "PluginNotDeactivated",
    inputs: [
      {
        type: "address",
        name: "plugin",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "PluginNotIPlugin",
    inputs: [
      {
        type: "address",
        name: "plugin",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "PluginZeroRewardToken",
    inputs: [
      {
        type: "address",
        name: "plugin",
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
    name: "TelRescueExceedsFree",
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
    name: "TelTransferMismatch",
    inputs: [
      {
        type: "uint256",
        name: "expected",
        internalType: "uint256"
      },
      {
        type: "uint256",
        name: "received",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "TimingBoundExceeded",
    inputs: [
      {
        type: "uint256",
        name: "requested",
        internalType: "uint256"
      },
      {
        type: "uint256",
        name: "bound",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "TooManyPendingWithdrawals",
    inputs: [
      {
        type: "uint256",
        name: "max",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "UUPSUnauthorizedCallContext",
    inputs: []
  },
  {
    type: "error",
    name: "UUPSUnsupportedProxiableUUID",
    inputs: [
      {
        type: "bytes32",
        name: "slot",
        internalType: "bytes32"
      }
    ]
  },
  {
    type: "error",
    name: "UnknownPlugin",
    inputs: [
      {
        type: "address",
        name: "plugin",
        internalType: "address"
      }
    ]
  },
  {
    type: "error",
    name: "VotesExpiredSignature",
    inputs: [
      {
        type: "uint256",
        name: "expiry",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "WithdrawalEmpty",
    inputs: [
      {
        type: "uint256",
        name: "id",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "WithdrawalStillInDelay",
    inputs: [
      {
        type: "uint256",
        name: "unlockTime",
        internalType: "uint256"
      }
    ]
  },
  {
    type: "error",
    name: "ZeroAddress",
    inputs: []
  },
  {
    type: "error",
    name: "ZeroAmount",
    inputs: []
  }
] as const;
