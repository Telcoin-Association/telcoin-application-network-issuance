import * as dotenv from "dotenv";
dotenv.config();

import {
  TokenTransferHistory,
  TokenTransfer,
} from "../datasources/TokenTransferHistory";
import { createPublicClient, getAbiItem, http } from "viem";
import { ERC20Abi } from "../abi/abi";
import {
  polTelCreationBlock,
  blockWithThreeTransfers,
  mockToken,
  mockThreeTransfers,
} from "./dummydata/mockTransfers";
import { ChainId, config } from "../config";
import { mainnet, polygon } from "viem/chains";

describe("TokenTransferHistory", () => {
  it("should be initialized initially", () => {
    const history = new TokenTransferHistory(
      mockToken,
      polTelCreationBlock,
      polTelCreationBlock
    );
    expect(history.initialized).toBe(false);
  });

  it("should initialize and fetch transfers", async () => {
    const history = new TokenTransferHistory(
      mockToken,
      blockWithThreeTransfers,
      blockWithThreeTransfers
    );
    await history.init();
    expect(history.initialized).toBe(true);

    const currentChain =
      history.token.chain === ChainId.Polygon ? polygon : mainnet;
    const publicClient = createPublicClient({
      chain: currentChain,
      transport: http(config.rpcUrls[history.token.chain]),
    });
    const threeTransferLogs = await publicClient.getLogs({
      address: history.token.address,
      event: getAbiItem({ abi: ERC20Abi, name: "Transfer" }),
      fromBlock: blockWithThreeTransfers,
      toBlock: blockWithThreeTransfers,
    });

    const expectedTransfers = threeTransferLogs.map((log) => {
      return {
        token: mockToken,
        from: log.args.from,
        to: log.args.to,
        amount: log.args.value,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
      };
    });

    expect(expectedTransfers).toEqual(mockThreeTransfers);
    expect(history.transfers).toEqual(mockThreeTransfers);
  });

  it("should throw error if accessing transfers before initialization", () => {
    const history = new TokenTransferHistory(
      mockToken,
      blockWithThreeTransfers,
      blockWithThreeTransfers
    );
    expect(() => history.transfers).toThrow("Not initialized");
  });

  it("should successfully return transfers via getTransfersForAddress", async () => {
    const history = new TokenTransferHistory(
      mockToken,
      blockWithThreeTransfers,
      blockWithThreeTransfers
    );
    await history.init();

    const toAddress = `0x9AC5637d295FEA4f51E086C329d791cC157B1C84`;
    const transfers = history.getTransfersForAddress(toAddress);
    expect(transfers.length).toBe(3);
  });

  it('should get transfers for a specific address with direction "to"', async () => {
    const history = new TokenTransferHistory(
      mockToken,
      blockWithThreeTransfers,
      blockWithThreeTransfers
    );
    await history.init();

    const toAddress = "0x9AC5637d295FEA4f51E086C329d791cC157B1C84";
    const transfers = history.getTransfersForAddress(toAddress, "to");
    expect(transfers.length).toBe(3);
    expect(transfers[0].to).toBe(toAddress);
  });

  it('should get transfers for a specific address with direction "from"', async () => {
    const history = new TokenTransferHistory(
      mockToken,
      blockWithThreeTransfers,
      blockWithThreeTransfers
    );
    await history.init();

    const fromAddress = "0x7bF36522E0Cd5106e40C3a6208722f17a3085163";
    const transfers = history.getTransfersForAddress(fromAddress, "from");
    expect(transfers.length).toBe(1);
    expect(transfers[0].from).toBe(fromAddress);
  });
});
